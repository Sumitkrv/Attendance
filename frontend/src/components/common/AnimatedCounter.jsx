import { useEffect, useState } from 'react'

export default function AnimatedCounter({ value, duration = 700 }) {
  const target = Number(value || 0)
  const [display, setDisplay] = useState(0)

  useEffect(() => {
    const start = performance.now()
    let frameId = 0

    const tick = (now) => {
      const progress = Math.min(1, (now - start) / duration)
      const eased = 1 - ((1 - progress) ** 3)
      setDisplay(Math.round(target * eased))
      if (progress < 1) {
        frameId = requestAnimationFrame(tick)
      }
    }

    frameId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frameId)
  }, [target, duration])

  return <>{display}</>
}
