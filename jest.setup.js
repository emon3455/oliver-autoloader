// Jest setup file to set environment variables before tests run
process.env.ENVIRONMENT = 'local';
process.env.LOGGING_ENABLED = 'true';
process.env.LOGGING_ENABLE_CONSOLE_LOGS = 'false'; // Disable console logs during tests for cleaner output
process.env.LOG_DEBUG_LEVEL = 'debug';
process.env.LOG_LOCAL_ROOT = './logs';
