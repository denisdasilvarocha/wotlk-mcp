export function installSignalHandlers(abort: () => void): () => void {
  function onInterrupt(): void {
    process.exitCode = 130
    abort()
  }

  function onTerminate(): void {
    process.exitCode = 143
    abort()
  }

  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onTerminate)

  return () => {
    process.off('SIGINT', onInterrupt)
    process.off('SIGTERM', onTerminate)
  }
}
