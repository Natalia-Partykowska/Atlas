//! When and what to download from CelesTrak, and the task that does it.
//!
//! One task owns the group store and is the only writer of the served catalog,
//! so retries and the daily refresh can't race to swap it:
//! - **Retries:** a missing or stale group is downloaded again after 30 min,
//!   then 1 h, then every 2 h, until it works. Only those groups are fetched.
//! - **Refresh:** every group is downloaded again at 04:00 UTC, except groups
//!   downloaded in the last 2 h. CelesTrak updates its data about every 2 h
//!   and blocks addresses that download the same data more often than that
//!   (Railway's outgoing addresses are shared with other apps).
//!
//! The catalog is re-assembled and swapped only when a download brought new
//! satellites, so clients aren't told it changed when it didn't. After every
//! pass the task publishes a `CatalogStatus` for `/health` and the stream.

use std::future::Future;
use std::sync::Arc;

use anyhow::Result;
use chrono::{DateTime, Duration, Utc};
use tracing::{info, warn};

use crate::catalog::{
    assemble, initial_catalog, Catalog, CatalogStatus, CatalogStatusRx, GroupStatus, GroupStore,
    SharedCatalog,
};
use crate::celestrak::{CelesTrak, RawEntry, SOURCES};

/// Gap between two downloads in one pass.
const DOWNLOAD_GAP: std::time::Duration = std::time::Duration::from_millis(800);

/// Downloads one CelesTrak group. `CelesTrak` in production; a fake in tests.
pub trait GroupFetcher: Send + Sync + 'static {
    fn download(&self, group: &'static str) -> impl Future<Output = Result<Vec<RawEntry>>> + Send;
}

impl GroupFetcher for CelesTrak {
    fn download(&self, group: &'static str) -> impl Future<Output = Result<Vec<RawEntry>>> + Send {
        self.fetch_group(group)
    }
}

/// Wall time, for the 04:00 refresh and the download times. Tests run it on
/// tokio's paused clock.
pub trait Clock: Send + Sync + 'static {
    fn now(&self) -> DateTime<Utc>;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }
}

impl<C: Clock> Clock for Arc<C> {
    fn now(&self) -> DateTime<Utc> {
        (**self).now()
    }
}

#[derive(Debug, Clone, Copy)]
pub enum Refresh {
    /// Every day at `hour`:00 UTC (production: 04:00).
    DailyAt { hour: u32 },
    /// Every so often, for local checks (`CATALOG_REFRESH_EVERY_SECS`).
    Every(std::time::Duration),
}

#[derive(Debug, Clone, Copy)]
pub struct Schedule {
    /// The first retry's delay; later ones double up to 4 × this. Also sets
    /// how recent a download the refresh skips (4 × this).
    pub retry_base: std::time::Duration,
    pub refresh: Refresh,
}

impl Schedule {
    /// Production: retries after 30 min, 1 h, then every 2 h; refresh at 04:00 UTC.
    pub const PRODUCTION: Schedule = Schedule {
        retry_base: std::time::Duration::from_secs(30 * 60),
        refresh: Refresh::DailyAt { hour: 4 },
    };

    /// The delay before retry number `n` (0-based) in a run of failures.
    pub fn retry_delay(&self, n: u32) -> std::time::Duration {
        self.retry_base * 2u32.pow(n.min(2))
    }

    /// The refresh skips groups downloaded more recently than this.
    pub fn polite_window(&self) -> std::time::Duration {
        self.retry_base * 4
    }

    pub fn next_refresh_after(&self, now: DateTime<Utc>) -> DateTime<Utc> {
        match self.refresh {
            Refresh::DailyAt { hour } => {
                let today = now
                    .date_naive()
                    .and_hms_opt(hour, 0, 0)
                    .expect("a valid hour")
                    .and_utc();
                if now < today {
                    today
                } else {
                    today + Duration::days(1)
                }
            }
            Refresh::Every(every) => now + to_chrono(every),
        }
    }
}

fn to_chrono(d: std::time::Duration) -> Duration {
    Duration::from_std(d).expect("schedule durations fit")
}

/// The next download pass: when, which groups (indices into `SOURCES`), and
/// whether it's a retry, the refresh, or both.
#[derive(Debug, PartialEq)]
struct Pass {
    at: DateTime<Utc>,
    groups: Vec<usize>,
    retry: bool,
    refresh: bool,
}

/// What the task knows between passes.
struct Upkeep {
    store: GroupStore,
    schedule: Schedule,
    retry_due: Option<DateTime<Utc>>,
    /// Retries scheduled in the current run of failures; picks the next delay.
    retries: u32,
    refresh_due: DateTime<Utc>,
}

impl Upkeep {
    fn new(store: GroupStore, schedule: Schedule, now: DateTime<Utc>) -> Self {
        let mut upkeep = Self {
            store,
            schedule,
            retry_due: None,
            retries: 0,
            refresh_due: schedule.next_refresh_after(now),
        };
        // Groups that failed at boot are retried like after any other pass.
        upkeep.after_pass(now, false, false);
        upkeep
    }

    fn next_pass(&self) -> Pass {
        let at = match self.retry_due {
            Some(retry) if retry < self.refresh_due => retry,
            _ => self.refresh_due,
        };
        let retry = self.retry_due.is_some_and(|due| due <= at);
        let refresh = self.refresh_due <= at;
        let recent = at - to_chrono(self.schedule.polite_window());
        let groups = self
            .store
            .slots()
            .iter()
            .enumerate()
            .filter(|(_, slot)| match slot.status() {
                // Missing and stale groups follow the retry delays, not the
                // refresh, so a failing group isn't asked for twice in a row.
                GroupStatus::Missing | GroupStatus::Stale => retry,
                GroupStatus::Fresh => refresh && slot.loaded_at().is_some_and(|t| t <= recent),
            })
            .map(|(i, _)| i)
            .collect();
        Pass {
            at,
            groups,
            retry,
            refresh,
        }
    }

    fn after_pass(&mut self, now: DateTime<Utc>, was_retry: bool, was_refresh: bool) {
        if was_refresh {
            self.refresh_due = self.schedule.next_refresh_after(now);
        }
        let healthy = self
            .store
            .slots()
            .iter()
            .all(|s| s.status() == GroupStatus::Fresh);
        if healthy {
            self.retry_due = None;
            self.retries = 0;
        } else if was_retry || self.retry_due.is_none() {
            // A retry that didn't fix everything, or a new failure: schedule
            // the next retry. A refresh leaves an already scheduled one alone.
            self.retry_due = Some(now + to_chrono(self.schedule.retry_delay(self.retries)));
            self.retries += 1;
        }
    }

    fn status(&self, version: u64) -> CatalogStatus {
        CatalogStatus::of(&self.store, version, self.retry_due)
    }

    fn log_schedule(&self) {
        let unhealthy: Vec<&str> = self
            .store
            .slots()
            .iter()
            .filter(|s| s.status() != GroupStatus::Fresh)
            .map(|s| s.name)
            .collect();
        match self.retry_due {
            Some(at) => warn!(
                groups = ?unhealthy,
                retry_at = %at.to_rfc3339(),
                next_refresh_at = %self.refresh_due.to_rfc3339(),
                "catalog groups to retry"
            ),
            None => info!(
                next_refresh_at = %self.refresh_due.to_rfc3339(),
                "every catalog group is fresh"
            ),
        }
    }
}

/// Downloads the groups at `which` (indices into `SOURCES`) into the store,
/// `DOWNLOAD_GAP` apart. Returns whether any group's satellites changed.
async fn download_groups(
    store: &mut GroupStore,
    fetcher: &impl GroupFetcher,
    clock: &impl Clock,
    which: &[usize],
) -> bool {
    let mut changed = false;
    for (n, &idx) in which.iter().enumerate() {
        if n > 0 {
            tokio::time::sleep(DOWNLOAD_GAP).await;
        }
        let download = fetcher.download(SOURCES[idx].1).await;
        changed |= store.record(idx, download, clock.now());
    }
    changed
}

/// Downloads every group and assembles the first catalog. Groups that fail
/// are missing until a retry works.
pub async fn load(celestrak: &CelesTrak) -> Result<(GroupStore, Catalog)> {
    let mut store = GroupStore::new();
    let all: Vec<usize> = (0..SOURCES.len()).collect();
    download_groups(&mut store, celestrak, &SystemClock, &all).await;
    let catalog = initial_catalog(&store, Utc::now())?;
    if !store.is_complete() {
        let missing: Vec<&str> = store.missing().collect();
        warn!(?missing, "starting with an incomplete catalog");
    }
    Ok((store, catalog))
}

/// Spawns the task that retries failed groups and refreshes the catalog (see
/// the module docs). It owns `store` and is the only writer of `shared`.
/// Returns the catalog status it publishes.
pub fn spawn_catalog_maintenance(
    shared: SharedCatalog,
    store: GroupStore,
    fetcher: impl GroupFetcher,
    schedule: Schedule,
    clock: impl Clock,
) -> CatalogStatusRx {
    let mut upkeep = Upkeep::new(store, schedule, clock.now());
    upkeep.log_schedule();
    let (status_tx, status_rx) = tokio::sync::watch::channel(upkeep.status(shared.load().version));
    tokio::spawn(async move {
        loop {
            let pass = upkeep.next_pass();
            let wait = (pass.at - clock.now()).to_std().unwrap_or_default();
            tokio::time::sleep(wait).await;

            if !pass.groups.is_empty() {
                let names: Vec<&str> = pass.groups.iter().map(|&i| SOURCES[i].1).collect();
                info!(groups = ?names, retry = pass.retry, refresh = pass.refresh, "downloading catalog groups");
                if download_groups(&mut upkeep.store, &fetcher, &clock, &pass.groups).await {
                    let catalog = assemble(&upkeep.store, shared.load().version, clock.now());
                    shared.store(Arc::new(catalog));
                }
            }
            upkeep.after_pass(clock.now(), pass.retry, pass.refresh);
            upkeep.log_schedule();
            // After the swap, so a client that reloads names for this version
            // gets this catalog's names.
            status_tx.send_replace(upkeep.status(shared.load().version));
        }
    });
    status_rx
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{assemble, GroupStatus};
    use crate::celestrak::SOURCES;
    use crate::test_support::tle;
    use anyhow::anyhow;
    use arc_swap::ArcSwap;
    use chrono::TimeZone;
    use std::collections::HashSet;
    use std::sync::Mutex;

    const MIN: i64 = 60;
    const HOUR: i64 = 60 * MIN;

    fn production() -> Schedule {
        Schedule {
            retry_base: std::time::Duration::from_secs(1800),
            refresh: Refresh::DailyAt { hour: 4 },
        }
    }

    /// `secs` after midnight UTC on 2026-10-12.
    fn at(secs: i64) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 12, 0, 0, 0).unwrap() + Duration::seconds(secs)
    }

    /// Wall time that moves with tokio's (paused) test clock.
    struct TestClock {
        wall: DateTime<Utc>,
        start: tokio::time::Instant,
    }

    impl Clock for TestClock {
        fn now(&self) -> DateTime<Utc> {
            self.wall + Duration::from_std(self.start.elapsed()).unwrap()
        }
    }

    type CallLog = Arc<Mutex<Vec<(&'static str, DateTime<Utc>)>>>;

    /// Answers instantly: each group has its own satellites, and a group in
    /// `failing` fails. Records every download and when it happened.
    #[derive(Clone)]
    struct FakeCelesTrak {
        clock: Arc<TestClock>,
        failing: Arc<Mutex<HashSet<&'static str>>>,
        calls: CallLog,
    }

    impl FakeCelesTrak {
        fn fail(&self, group: &'static str) {
            self.failing.lock().unwrap().insert(group);
        }
        fn heal(&self, group: &'static str) {
            self.failing.lock().unwrap().remove(group);
        }
        /// When `group` was downloaded, in seconds after midnight.
        fn calls_to(&self, group: &str) -> Vec<i64> {
            let midnight = at(0);
            self.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|(g, _)| *g == group)
                .map(|(_, t)| (*t - midnight).num_seconds())
                .collect()
        }
        fn all_calls(&self) -> Vec<(&'static str, DateTime<Utc>)> {
            self.calls.lock().unwrap().clone()
        }
    }

    fn satellites_of(group: &str) -> Vec<u32> {
        let i = SOURCES.iter().position(|(_, n)| *n == group).unwrap() as u32;
        if group == "active" {
            (1000..1010).collect()
        } else {
            vec![100 + i * 10, 101 + i * 10]
        }
    }

    impl GroupFetcher for FakeCelesTrak {
        fn download(
            &self,
            group: &'static str,
        ) -> impl std::future::Future<Output = Result<Vec<RawEntry>>> + Send {
            self.calls.lock().unwrap().push((group, self.clock.now()));
            let result = if self.failing.lock().unwrap().contains(group) {
                Err(anyhow!("503 Service Unavailable"))
            } else {
                Ok(satellites_of(group).into_iter().map(tle).collect())
            };
            async move { result }
        }
    }

    struct Setup {
        fake: FakeCelesTrak,
        shared: SharedCatalog,
        clock: Arc<TestClock>,
        status: CatalogStatusRx,
    }

    /// The server as it is after booting at `boot` (seconds after midnight):
    /// every group downloaded once at `loaded` except those in `missing`, and
    /// the maintenance task running.
    fn boot(boot: i64, loaded: i64, missing: &[&'static str]) -> Setup {
        let clock = Arc::new(TestClock {
            wall: at(boot),
            start: tokio::time::Instant::now(),
        });
        let fake = FakeCelesTrak {
            clock: clock.clone(),
            failing: Arc::new(Mutex::new(missing.iter().copied().collect())),
            calls: Arc::new(Mutex::new(Vec::new())),
        };
        let mut store = GroupStore::new();
        for (i, (_, name)) in SOURCES.iter().enumerate() {
            let download = if missing.contains(name) {
                Err(anyhow!("503 at boot"))
            } else {
                Ok(satellites_of(name).into_iter().map(tle).collect())
            };
            store.record(i, download, at(loaded));
        }
        let shared: SharedCatalog = Arc::new(ArcSwap::from_pointee(assemble(&store, 0, at(boot))));
        let status = spawn_catalog_maintenance(
            shared.clone(),
            store,
            fake.clone(),
            production(),
            clock.clone(),
        );
        Setup {
            fake,
            shared,
            clock,
            status,
        }
    }

    /// Lets the server run until `secs` after midnight.
    async fn run_until(clock: &TestClock, secs: i64) {
        let wait = (at(secs) - clock.now()).to_std().unwrap();
        tokio::time::sleep(wait).await;
    }

    #[test]
    fn retries_back_off_to_every_two_hours() {
        let delays: Vec<u64> = (0..6)
            .map(|n| production().retry_delay(n).as_secs() / 60)
            .collect();
        assert_eq!(delays, [30, 60, 120, 120, 120, 120]);
        assert_eq!(production().polite_window().as_secs(), 2 * 3600);
    }

    #[test]
    fn the_daily_refresh_is_at_0400_utc() {
        let s = production();
        assert_eq!(s.next_refresh_after(at(3 * HOUR + 59 * MIN)), at(4 * HOUR));
        assert_eq!(s.next_refresh_after(at(4 * HOUR)), at(28 * HOUR));
        assert_eq!(s.next_refresh_after(at(5 * HOUR)), at(28 * HOUR));
        let every = Schedule {
            retry_base: std::time::Duration::from_secs(10),
            refresh: Refresh::Every(std::time::Duration::from_secs(120)),
        };
        assert_eq!(every.next_refresh_after(at(5 * HOUR)), at(5 * HOUR + 120));
    }

    #[tokio::test(start_paused = true)]
    async fn a_group_missing_at_boot_is_retried_until_it_comes_back() {
        let Setup {
            fake,
            shared,
            clock,
            ..
        } = boot(5 * HOUR, 5 * HOUR, &["active"]);
        let partial = shared.load().len();
        let first_version = shared.load().version;

        // CelesTrak keeps refusing `active` for 4 hours.
        run_until(&clock, 9 * HOUR).await;
        fake.heal("active");
        run_until(&clock, 27 * HOUR).await;

        // Retried at +30 min, then 1 h and 2 h apart.
        assert_eq!(
            fake.calls_to("active"),
            [
                5 * HOUR + 30 * MIN,
                6 * HOUR + 30 * MIN,
                8 * HOUR + 30 * MIN,
                10 * HOUR + 30 * MIN
            ]
        );
        // Only `active` was downloaded: nothing else until the 04:00 refresh.
        assert!(fake.all_calls().iter().all(|(g, _)| *g == "active"));
        assert_eq!(shared.load().len(), partial + satellites_of("active").len());
        assert!(shared.load().version > first_version);
    }

    #[tokio::test(start_paused = true)]
    async fn retries_that_fail_again_dont_replace_the_catalog() {
        let Setup {
            fake,
            shared,
            clock,
            ..
        } = boot(5 * HOUR, 5 * HOUR, &["active"]);
        let before = shared.load_full();

        run_until(&clock, 9 * HOUR).await;

        assert_eq!(fake.calls_to("active").len(), 3);
        assert!(
            Arc::ptr_eq(&before, &shared.load_full()),
            "nothing changed, so clients keep their names"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn the_status_follows_every_pass() {
        let Setup {
            fake,
            shared,
            clock,
            status,
        } = boot(5 * HOUR, 5 * HOUR, &["active"]);
        let first_version = shared.load().version;

        let booted = status.borrow().clone();
        assert_eq!(booted.version, first_version);
        assert_eq!(booted.missing(), ["active"]);
        assert_eq!(booted.next_retry_at, Some(at(5 * HOUR + 30 * MIN)));

        // The 05:30 retry fails: the next one is an hour later, the catalog
        // and its version stay.
        run_until(&clock, 5 * HOUR + 31 * MIN).await;
        let failed = status.borrow().clone();
        assert_eq!(failed.version, first_version);
        assert_eq!(failed.missing(), ["active"]);
        assert_eq!(failed.next_retry_at, Some(at(6 * HOUR + 30 * MIN)));
        let active = failed.groups.iter().find(|g| g.name == "active").unwrap();
        assert_eq!(
            active.failure.as_ref().map(|f| f.at),
            Some(at(5 * HOUR + 30 * MIN))
        );

        // The 06:30 retry works: complete, nothing left to retry, and the
        // version is the served catalog's.
        fake.heal("active");
        run_until(&clock, 6 * HOUR + 31 * MIN).await;
        let restored = status.borrow().clone();
        assert!(restored.is_complete());
        assert_eq!(restored.next_retry_at, None);
        assert!(restored.version > first_version);
        assert_eq!(restored.version, shared.load().version);
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_refresh_keeps_the_group_and_retries_it_after_30_min() {
        let Setup {
            fake,
            shared,
            clock,
            ..
        } = boot(3 * HOUR, HOUR, &[]);
        let full = shared.load().len();
        fake.fail("active");

        run_until(&clock, 4 * HOUR + 10 * MIN).await;
        // The 04:00 refresh downloaded every group, 800 ms apart.
        let refresh = fake.all_calls();
        assert_eq!(refresh.len(), SOURCES.len());
        for pair in refresh.windows(2) {
            assert!(pair[1].1 - pair[0].1 >= Duration::milliseconds(800));
        }
        // `active` failed: it's stale, and every satellite is still there.
        assert_eq!(shared.load().len(), full);

        fake.heal("active");
        run_until(&clock, 5 * HOUR).await;
        let active = fake.calls_to("active");
        assert_eq!(active.len(), 2);
        let refresh_end = active[0];
        assert_eq!(active[1], refresh_end + 30 * MIN);
        assert_eq!(shared.load().len(), full);
    }

    #[tokio::test(start_paused = true)]
    async fn the_refresh_skips_groups_downloaded_in_the_last_two_hours() {
        // Booted at 03:00 without `active`; the other groups are from 01:00.
        let Setup { fake, clock, .. } = boot(3 * HOUR, HOUR, &["active"]);
        fake.heal("active");

        run_until(&clock, 4 * HOUR + 10 * MIN).await;

        // The 03:30 retry got `active`, so the 04:00 refresh leaves it out.
        assert_eq!(fake.calls_to("active"), [3 * HOUR + 30 * MIN]);
        for (_, name) in SOURCES.iter().filter(|(_, n)| *n != "active") {
            assert_eq!(fake.calls_to(name).len(), 1, "{name} refreshed once");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn the_refresh_neither_asks_a_failing_group_again_nor_delays_its_retry() {
        // Booted at 03:00 without `active`, which keeps failing.
        let Setup { fake, clock, .. } = boot(3 * HOUR, HOUR, &["active"]);

        run_until(&clock, 6 * HOUR).await;

        // Retries at 03:30 and 04:30 (1 h later). The 04:00 refresh in
        // between leaves `active` to the retries and doesn't push them back.
        assert_eq!(
            fake.calls_to("active"),
            [3 * HOUR + 30 * MIN, 4 * HOUR + 30 * MIN]
        );
        assert_eq!(fake.calls_to("stations"), [4 * HOUR]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_short_test_schedule_runs_in_seconds() {
        let clock = Arc::new(TestClock {
            wall: at(5 * HOUR),
            start: tokio::time::Instant::now(),
        });
        let fake = FakeCelesTrak {
            clock: clock.clone(),
            failing: Arc::new(Mutex::new(HashSet::new())),
            calls: Arc::new(Mutex::new(Vec::new())),
        };
        let mut store = GroupStore::new();
        for i in 0..SOURCES.len() {
            store.record(i, Err(anyhow!("503 at boot")), at(5 * HOUR));
        }
        assert!(store
            .slots()
            .iter()
            .all(|s| s.status() == GroupStatus::Missing));
        let shared: SharedCatalog = Arc::new(ArcSwap::from_pointee(assemble(&store, 0, at(0))));
        let schedule = Schedule {
            retry_base: std::time::Duration::from_secs(10),
            refresh: Refresh::Every(std::time::Duration::from_secs(120)),
        };
        spawn_catalog_maintenance(shared.clone(), store, fake.clone(), schedule, clock.clone());

        // Every group was missing, so the first retry (+10 s) downloads all of
        // them, 800 ms apart.
        run_until(&clock, 5 * HOUR + 15).await;
        assert_eq!(fake.calls_to("stations"), [5 * HOUR + 10]);
        assert_eq!(fake.calls_to("active").len(), 1);
        run_until(&clock, 5 * HOUR + 125).await;
        // Refreshed at +120 s (all groups were downloaded at +10 s, more than
        // 4 × 10 s earlier).
        assert_eq!(fake.calls_to("stations"), [5 * HOUR + 10, 5 * HOUR + 120]);
    }
}
