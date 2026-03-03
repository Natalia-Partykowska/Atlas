import Map from '@/components/map/Map'
import Tooltip from '@/components/overlays/Tooltip'
import LayerSwitcher from '@/components/overlays/LayerSwitcher'
import Legend from '@/components/overlays/Legend'
import CompareSizesButton from '@/components/overlays/CompareSizesButton'

export default function App() {
  return (
    <div className="w-full h-full relative bg-[#080B12]">
      <Map />
      <LayerSwitcher />
      <Legend />
      <Tooltip />
      <CompareSizesButton />
    </div>
  )
}
