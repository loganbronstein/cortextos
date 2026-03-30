module.exports = {
  "apps": [
    {
      "name": "cortextos-daemon",
      "script": "/Users/cortextos/cortextos-e2e-phase/dist/daemon.js",
      "args": "--instance e2e-phase",
      "cwd": "/Users/cortextos/cortextos-e2e-phase",
      "env": {
        "CTX_INSTANCE_ID": "e2e-phase",
        "CTX_ROOT": "/Users/cortextos/.cortextos/e2e-phase",
        "CTX_PROJECT_ROOT": "/Users/cortextos/cortextos-e2e-phase"
      },
      "max_restarts": 10,
      "restart_delay": 5000,
      "autorestart": true
    }
  ]
};
