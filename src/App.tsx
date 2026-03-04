import Map from '@/components/map/Map'
import Tooltip from '@/components/overlays/Tooltip'
import LayerSwitcher from '@/components/overlays/LayerSwitcher'
import Legend from '@/components/overlays/Legend'
import Toolbar from '@/components/overlays/Toolbar'

export default function App() {
  return (
    <div className="w-full h-full relative bg-[#080B12]">
      <Map />
      <LayerSwitcher />
      <Legend />
      <Tooltip />
      <Toolbar />
    </div>
  )
}
