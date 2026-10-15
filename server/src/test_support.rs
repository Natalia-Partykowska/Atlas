//! Helpers shared by the unit tests.

use crate::celestrak::RawEntry;

pub const ISS_LINE1: &str = "1 25544U 98067A   26076.83874734  .00009567  00000+0  18567-3 0  9991";
pub const ISS_LINE2: &str = "2 25544  51.6336  32.0723 0006231 202.9067 157.1644 15.48349303557590";

/// A valid TLE for `norad` (the ISS's elements under another number).
pub fn tle(norad: u32) -> RawEntry {
    let id = format!("{norad:05}");
    RawEntry {
        name: format!("SAT {norad}"),
        line1: with_checksum(&ISS_LINE1[..68].replacen("25544", &id, 1)),
        line2: with_checksum(&ISS_LINE2[..68].replacen("25544", &id, 1)),
    }
}

/// Appends the TLE checksum (column 69) to a 68-character line.
fn with_checksum(line: &str) -> String {
    let sum: u32 = line
        .bytes()
        .map(|c| match c {
            b'-' => 1,
            b'0'..=b'9' => u32::from(c - b'0'),
            _ => 0,
        })
        .sum();
    format!("{line}{}", sum % 10)
}
