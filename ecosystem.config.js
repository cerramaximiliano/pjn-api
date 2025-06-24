module.exports = {
    apps: [
        {
            name: "pjn/api",
            script: "src/server.js",
            cwd: "/var/www/pjn-api",
            exec_mode: "fork", 
            instances: 1,
            autorestart: true,
            watch: [
                "src", // Monitorea solo el directorio 'server'
            ],
            ignore_watch: [
                "node_modules",
                "src/logger.log",
                "src/logs",
                "logs",
                "*.log",
                "temp",
                "uploads"
            ],
            watch_options: {
                followSymlinks: false
            },
            max_memory_restart: "1G",
            env: {
                NODE_ENV: "production"
            },
            env_development: {
                NODE_ENV: "development",
                PORT: 3003
            }
        }
    ]
};