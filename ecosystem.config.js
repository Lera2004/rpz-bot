module.exports = {
  apps: [
    {
      name: 'teacher-grades-bot',
      script: 'src/index.js',
      env: {
        NODE_ENV: 'production'
      },
      watch: false,
      autorestart: true,
      exp_backoff_restart_delay: 1000,
      max_restarts: 10,
      instances: 1,
      exec_mode: 'fork'
    }
  ]
};
