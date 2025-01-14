module.exports = {
  apps: [
    {
      name: 'rsshub',
      script: './lib/index.ts',
      max_memory_restart: '200M',
      autorestart: true,
      interceptor: '~/.bun/bin/bun'
    }
  ]
}
