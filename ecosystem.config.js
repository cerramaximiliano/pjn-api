module.exports = {
    apps: [
        {
            name: "pjn/api",
            script: "src/server.js",
            exec_mode: "fork", 
            instances: 1,
            autorestart: true,
            // watch deshabilitado: el deploy (CI en hub / deploy-worker01.sh en worker_01)
            // hace reload explícito; con watch ON el git reset del CI reiniciaba la app
            // en medio del npm ci → crash-loop MODULE_NOT_FOUND en cada deploy
            watch: false,
            max_memory_restart: "1G",
            env: {
                NODE_ENV: "production",
                HYDE_ENABLED: "true"
            },
            env_development: {
                NODE_ENV: "development",
                PORT: 3003,
                HYDE_ENABLED: "true"
            },
            env_local: {
                NODE_ENV: "local",
                PORT: 8083,
                HYDE_ENABLED: "true"
            }
        }
    ]
};