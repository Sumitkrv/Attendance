// ==========================================================================
// Item 10: Frontend hook for Server-Sent Events (SSE) real-time updates
// ==========================================================================
import { useEffect, useRef, useCallback, useState } from 'react'
import { BASE_URL } from '../config/apiConfig'

/**
 * Hook: Connect to SSE endpoint for real-time updates.
 *
 * Usage:
 *   const { lastEvent, isConnected } = useRealtimeEvents({
 *     topics: ['attendance', 'notifications'],
 *     onEvent: (event) => console.log('New event:', event),
 *   })
 */
export function useRealtimeEvents({ topics = [], onEvent, enabled = true } = {}) {
  const [isConnected, setIsConnected] = useState(false)
  const [lastEvent, setLastEvent] = useState(null)
  const [connectionAttempts, setConnectionAttempts] = useState(0)
  const eventSourceRef = useRef(null)
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  const connect = useCallback(() => {
    if (!enabled) return

    const topicParam = topics.length > 0 ? `?topics=${topics.join(',')}` : ''
    const url = `${BASE_URL}/api/events/stream${topicParam}`

    try {
      const es = new EventSource(url)

      es.onopen = () => {
        setIsConnected(true)
        setConnectionAttempts(0)
      }

      es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data)
          setLastEvent(data)
          onEventRef.current?.(data)
        } catch {
          // ignore non-JSON messages (keepalive)
        }
      }

      es.addEventListener('attendance_update', (e) => {
        try {
          const data = JSON.parse(e.data)
          setLastEvent(data)
          onEventRef.current?.(data)
        } catch { /* no-op */ }
      })

      es.addEventListener('notification', (e) => {
        try {
          const data = JSON.parse(e.data)
          setLastEvent(data)
          onEventRef.current?.(data)
        } catch { /* no-op */ }
      })

      es.addEventListener('task_update', (e) => {
        try {
          const data = JSON.parse(e.data)
          setLastEvent(data)
          onEventRef.current?.(data)
        } catch { /* no-op */ }
      })

      es.onerror = () => {
        setIsConnected(false)
        es.close()
        // Reconnect with exponential backoff
        const delay = Math.min(30000, 1000 * Math.pow(2, connectionAttempts))
        setConnectionAttempts((prev) => prev + 1)
        setTimeout(connect, delay)
      }

      eventSourceRef.current = es
    } catch {
      // SSE not supported or network error
      setIsConnected(false)
    }
  }, [enabled, topics.join(','), connectionAttempts])

  useEffect(() => {
    connect()
    return () => {
      eventSourceRef.current?.close()
      setIsConnected(false)
    }
  }, [connect])

  const disconnect = useCallback(() => {
    eventSourceRef.current?.close()
    setIsConnected(false)
  }, [])

  return { lastEvent, isConnected, disconnect, connectionAttempts }
}
