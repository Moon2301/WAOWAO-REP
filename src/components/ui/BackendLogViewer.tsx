'use client'

import React, { useState, useEffect, useRef } from 'react'
import { useSSE } from '@/lib/query/hooks/useSSE'
import { TASK_SSE_EVENT_TYPE, type SSEEvent } from '@/lib/task/types'
import { AppIcon } from '@/components/ui/icons'

export interface LogEntry {
  id: string
  timestamp: string
  taskType?: string | null
  taskId?: string
  stage?: string | null
  progress?: number
  message: string
  level: 'info' | 'success' | 'error' | 'warn' | 'progress'
}

export interface BackendLogViewerProps {
  projectId: string
  taskId?: string
  title?: string
  className?: string
  defaultCollapsed?: boolean
  enabled?: boolean
}

export const BackendLogViewer: React.FC<BackendLogViewerProps> = ({
  projectId,
  taskId,
  title = 'Backend Service Logs (SSE Realtime Stream)',
  className = '',
  defaultCollapsed = false,
  enabled = true,
}) => {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed)
  const [filterLevel, setFilterLevel] = useState<string>('all')
  const [isLive, setIsLive] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const liveTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (autoScroll && scrollRef.current && !isCollapsed) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logs, autoScroll, isCollapsed])

  useSSE({
    projectId,
    enabled,
    onEvent: (event: SSEEvent) => {
      // Trigger live indicator pulse
      setIsLive(true)
      if (liveTimeoutRef.current) clearTimeout(liveTimeoutRef.current)
      liveTimeoutRef.current = setTimeout(() => setIsLive(false), 3000)

      if (event.type !== TASK_SSE_EVENT_TYPE.LIFECYCLE && event.type !== TASK_SSE_EVENT_TYPE.STREAM) {
        return
      }

      // If filtering by a specific taskId
      if (taskId && event.taskId !== taskId) {
        return
      }

      const payload = event.payload as {
        progress?: number
        stage?: string
        stageLabel?: string
        message?: string
        status?: string
        error?: string
        lifecycleType?: string
      } | null

      if (!payload) return

      const ts = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
      const taskType = event.taskType || 'SYSTEM'
      const status = payload.status || payload.lifecycleType
      const progress = payload.progress

      let level: LogEntry['level'] = 'info'
      let message = payload.message || ''

      if (status === 'completed' || status === 'task.completed') {
        level = 'success'
        if (!message) message = `Task [${taskType}] completed successfully!`
      } else if (status === 'failed' || status === 'task.failed') {
        level = 'error'
        if (!message) message = payload.error || `Task [${taskType}] failed to execute.`
      } else if (typeof progress === 'number') {
        level = 'progress'
        if (!message) {
          message = payload.stage
            ? `Stage: ${payload.stage} (${progress}%)`
            : `Processing task progress: ${progress}%`
        }
      } else {
        if (!message) message = `Worker event received for [${taskType}]`
      }

      // Avoid duplicate consecutive identical messages
      setLogs((prev) => {
        const lastLog = prev[prev.length - 1]
        if (lastLog && lastLog.message === message && lastLog.progress === progress && lastLog.taskType === taskType) {
          return prev
        }
        return [
          ...prev,
          {
            id: `${event.id || Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
            timestamp: ts,
            taskType,
            taskId: event.taskId,
            stage: payload.stage,
            progress,
            message,
            level,
          },
        ]
      })
    },
  })

  const filteredLogs = logs.filter((log) => {
    if (filterLevel === 'all') return true
    return log.level === filterLevel
  })

  const clearLogs = () => setLogs([])

  const getLevelBadge = (level: LogEntry['level']) => {
    switch (level) {
      case 'success':
        return <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">SUCCESS</span>
      case 'error':
        return <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-400 border border-rose-500/30">ERROR</span>
      case 'warn':
        return <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">WARN</span>
      case 'progress':
        return <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-400 border border-cyan-500/30">PROG</span>
      default:
        return <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 border border-blue-500/30">INFO</span>
    }
  }

  return (
    <div className={`w-full rounded-xl overflow-hidden border border-white/10 shadow-2xl bg-[#0a0d14]/90 backdrop-blur-md transition-all duration-300 ${className}`}>
      {/* Terminal Top Bar */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-[#141a24] border-b border-white/10 select-none">
        <div className="flex items-center gap-3">
          {/* macOS Traffic Lights */}
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-full bg-[#ff5f56] border border-[#e0443e]/50" />
            <div className="w-3 h-3 rounded-full bg-[#ffbd2e] border border-[#dea123]/50" />
            <div className="w-3 h-3 rounded-full bg-[#27c93f] border border-[#1aab29]/50" />
          </div>
          <div className="h-4 w-[1px] bg-white/10 mx-1" />
          <div className="flex items-center gap-2 text-xs font-mono font-semibold text-foreground/80">
            <AppIcon name="terminal" className="w-3.5 h-3.5 text-emerald-400 animate-pulse" />
            <span>{title}</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Live Indicator Badge */}
          <div className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-mono transition-all ${isLive ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 shadow-[0_0_10px_rgba(16,185,129,0.3)]' : 'bg-white/5 text-foreground/40 border border-white/5'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${isLive ? 'bg-emerald-400 animate-ping' : 'bg-foreground/30'}`} />
            <span>{isLive ? 'LIVE STREAM' : 'IDLE'}</span>
          </div>

          {/* Filter Dropdown/Buttons */}
          {!isCollapsed && (
            <div className="flex items-center gap-1 bg-black/40 p-0.5 rounded-lg border border-white/5 text-[11px]">
              {(['all', 'progress', 'success', 'error'] as const).map((lvl) => (
                <button
                  key={lvl}
                  onClick={() => setFilterLevel(lvl)}
                  className={`px-2 py-0.5 rounded capitalize transition-colors ${filterLevel === lvl ? 'bg-white/10 text-white font-medium' : 'text-foreground/50 hover:text-foreground/80'}`}
                >
                  {lvl}
                </button>
              ))}
            </div>
          )}

          {/* Auto Scroll Toggle */}
          {!isCollapsed && (
            <button
              onClick={() => setAutoScroll(!autoScroll)}
              title={autoScroll ? 'Auto-scroll enabled' : 'Auto-scroll paused'}
              className={`p-1 rounded text-xs transition-colors ${autoScroll ? 'text-emerald-400 bg-emerald-500/10' : 'text-foreground/40 hover:text-foreground/80'}`}
            >
              <AppIcon name="arrowDownCircle" className="w-3.5 h-3.5" />
            </button>
          )}

          {/* Clear Logs */}
          {!isCollapsed && (
            <button
              onClick={clearLogs}
              title="Clear Logs"
              className="p-1 rounded text-foreground/50 hover:text-rose-400 hover:bg-rose-500/10 transition-colors text-xs"
            >
              <AppIcon name="trash" className="w-3.5 h-3.5" />
            </button>
          )}

          {/* Collapse Toggle */}
          <button
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="p-1 rounded text-foreground/60 hover:text-white transition-colors"
          >
            <AppIcon name={isCollapsed ? 'chevronDown' : 'chevronUp'} className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Terminal Body */}
      {!isCollapsed && (
        <div
          ref={scrollRef}
          className="p-4 font-mono text-xs overflow-y-auto max-h-[340px] min-h-[160px] space-y-1.5 text-foreground/80 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent"
        >
          {filteredLogs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-foreground/30 space-y-2 select-none">
              <AppIcon name="code" className="w-8 h-8 opacity-40" />
              <p>{filterLevel === 'all' ? '> No log messages received yet. Start processing to stream backend logs...' : `> No logs matching filter [${filterLevel}]`}</p>
            </div>
          ) : (
            filteredLogs.map((log) => (
              <div
                key={log.id}
                className="flex items-start gap-2 py-1 px-2 rounded hover:bg-white/[0.03] transition-colors border-l-2 border-transparent hover:border-emerald-500/50"
              >
                <span className="text-foreground/40 shrink-0 select-none">[{log.timestamp}]</span>
                {getLevelBadge(log.level)}
                {log.taskType && (
                  <span className="text-amber-400/90 shrink-0 font-semibold select-none">[{log.taskType}]</span>
                )}
                <span className="break-all flex-1 text-foreground/90 leading-relaxed">{log.message}</span>
                {typeof log.progress === 'number' && log.progress > 0 && log.progress < 100 && (
                  <span className="text-cyan-400 font-bold shrink-0">({log.progress}%)</span>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
