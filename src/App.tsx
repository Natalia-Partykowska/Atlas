import Map from '@/components/map/Map'
import Tooltip from '@/components/overlays/Tooltip'

export default function App() {
  return (
    <div className="w-full h-full relative bg-[#080B12]">
      <Map />
      <Tooltip />
    </div>
  )
}
