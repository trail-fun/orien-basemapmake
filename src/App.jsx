import { useState } from 'react'
import MapEditor from './components/MapEditor'
import OutputView from './components/OutputView'
import './App.css'

export default function App() {
  const [screen, setScreen] = useState('editor')
  const [state, setState] = useState({
    mapType: 'std',
    paperSize: 'A4',
    orientation: 'portrait',
    scale: 10000,
    printCenter: null,   // { lng, lat }
    cps: [],
    memo: '',
    showOrder: true,
    showScore: true,
    showLine: true,
  })

  return (
    <div className="app">
      {screen === 'editor' ? (
        <MapEditor state={state} setState={setState} onNext={() => setScreen('output')} />
      ) : (
        <OutputView state={state} onBack={() => setScreen('editor')} />
      )}
    </div>
  )
}
