import { createArtifactPreviewRpcHandler } from './src/host-rpc.mjs'

export const name = 'artifact-preview'
export const inject = ['connection', 'sessions', 'sessionPersistence']

export function apply(ctx) {
  const disposeRpc = ctx.connection.rpc.handle(
    '/artifact-preview',
    createArtifactPreviewRpcHandler({
      sessions: ctx.sessions,
      sessionPersistence: ctx.sessionPersistence,
    }),
    { authority: 'loopback' },
  )
  ctx.effect(() => async () => {
    await disposeRpc()
  }, 'artifact-preview: loopback reader')
}
