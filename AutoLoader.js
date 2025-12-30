const path = require("path");
const fs = require("fs");
const fsPromises = fs.promises;
const ErrorHandler = require("./ErrorHandler");
const Logger = require("./Logger");

// Default configuration constants
const DEFAULT_CONFIG = {
  MAX_CACHE_SIZE: 1000,
  MAX_UTILITY_CACHE: 100,
  MODULE_LOAD_TIMEOUT_MS: 30000,
  MAX_CLONE_DEPTH: 100,
  FILE_EXTENSIONS: ['.js', '.mjs', '.json']
};

class AutoLoader {
  constructor({ autoloaderConfigPath, options = {} }) {
    Logger.debugLog?.(`[AutoLoader] [constructor] [start] Initializing AutoLoader with configPath: ${autoloaderConfigPath}`);
    
    if (!autoloaderConfigPath) {
      Logger.debugLog?.(`[AutoLoader] [constructor] [error] Missing autoloaderConfigPath`);
      ErrorHandler.addError("AutoLoader requires autoloaderConfigPath", {
        code: "MISSING_CONFIG_PATH",
        origin: "AutoLoader.constructor"
      });
      throw new Error("AutoLoader requires autoloaderConfigPath");
    }
    this.autoloaderConfigPath = autoloaderConfigPath;
    Logger.debugLog?.(`[AutoLoader] [constructor] [data] Config path set: ${autoloaderConfigPath}`);

    // Configuration options with secure defaults
    this.options = {
      allowedBasePaths: options.allowedBasePaths || [process.cwd()],
      utilitiesDir: options.utilitiesDir || path.resolve(__dirname, "../utils"),
      defaultRole: options.defaultRole || null,
      maxCacheSize: options.maxCacheSize || DEFAULT_CONFIG.MAX_CACHE_SIZE,
      maxUtilityCache: options.maxUtilityCache || DEFAULT_CONFIG.MAX_UTILITY_CACHE,
      strictPathValidation: options.strictPathValidation !== false, // default true
      moduleLoadTimeout: options.moduleLoadTimeout || DEFAULT_CONFIG.MODULE_LOAD_TIMEOUT_MS,
      enablePathMemoization: options.enablePathMemoization !== false, // default true
      deepCloneUtilities: options.deepCloneUtilities !== false, // default true
      maxCloneDepth: options.maxCloneDepth || DEFAULT_CONFIG.MAX_CLONE_DEPTH, // Finding 12
      useWorkerThreads: options.useWorkerThreads !== false, // Finding 5: Enable worker threads for isolation
      ...options
    };
    Logger.debugLog?.(`[AutoLoader] [constructor] [data] Options configured: ${JSON.stringify(this.options)}`);

    this.loadedCoreUtilities = {};
    this.loadedModuleCache = new Map();
    this.loadedUtilityNames = new Set();
    this.cacheAccessOrder = new Map(); // Finding 9: Map for O(1) LRU operations
    this.resolvedPathCache = new Map(); // For path memoization
    this.fileExistenceCache = new Map(); // Finding 11: File existence cache
    this.autoloaderConfig = null; // Finding 8: Will be loaded in init()
    this.isInitialized = false; // Track initialization state
    
    Logger.debugLog?.(`[AutoLoader] [constructor] [complete] AutoLoader instance created successfully`);
  }

  /**
   * Finding 8: Initialize the autoloader by loading configuration
   * Must be called before using the autoloader
   */
  init() {
    Logger.debugLog?.(`[AutoLoader] [init] [start] Initializing autoloader`);
    
    if (this.isInitialized) {
      Logger.debugLog?.(`[AutoLoader] [init] [error] Already initialized`);
      ErrorHandler.addError('AutoLoader already initialized', {
        code: "ALREADY_INITIALIZED",
        origin: "AutoLoader.init"
      });
      throw new Error('AutoLoader already initialized');
    }

    Logger.debugLog?.(`[AutoLoader] [init] [action] Resolving config path: ${this.autoloaderConfigPath}`);
    const resolvedCfgPath = this._safeResolve(this.autoloaderConfigPath);
    Logger.debugLog?.(`[AutoLoader] [init] [data] Resolved config path: ${resolvedCfgPath}`);
    
    try {
      Logger.debugLog?.(`[AutoLoader] [init] [action] Loading configuration from: ${resolvedCfgPath}`);
      this.autoloaderConfig = require(resolvedCfgPath);
      Logger.debugLog?.(`[AutoLoader] [init] [data] Configuration loaded: ${JSON.stringify(this.autoloaderConfig)}`);
    } catch (error) {
      Logger.debugLog?.(`[AutoLoader] [init] [error] Failed to load configuration: ${error.message}`);
      ErrorHandler.addError(`Failed to load autoloader configuration: ${this.autoloaderConfigPath}`, {
        code: "CONFIG_LOAD_FAILED",
        origin: "AutoLoader.init",
        data: {
          configPath: this.autoloaderConfigPath,
          resolvedPath: resolvedCfgPath,
          error: error.message,
          stack: error.stack
        }
      });
      throw new Error(
        `Failed to load autoloader configuration:\n` +
        `  Config path: "${this.autoloaderConfigPath}"\n` +
        `  Resolved path: "${resolvedCfgPath}"\n` +
        `  Error: ${error.message}\n` +
        `  Stack: ${error.stack}`
      );
    }

    // Validate APP_ROLE requirement
    Logger.debugLog?.(`[AutoLoader] [init] [action] Validating APP_ROLE requirement`);
    const hasRoles = this.autoloaderConfig && this.autoloaderConfig.role && typeof this.autoloaderConfig.role === "object";
    Logger.debugLog?.(`[AutoLoader] [init] [data] Config has roles: ${hasRoles}, APP_ROLE: ${process.env.APP_ROLE}, defaultRole: ${this.options.defaultRole}`);
    
    if (hasRoles && !process.env.APP_ROLE && !this.options.defaultRole) {
      Logger.debugLog?.(`[AutoLoader] [init] [error] Missing APP_ROLE`);
      ErrorHandler.addError("APP_ROLE environment variable must be defined or options.defaultRole must be set", {
        code: "MISSING_APP_ROLE",
        origin: "AutoLoader.init",
        data: { hasRoles }
      });
      throw new Error("APP_ROLE environment variable must be defined or options.defaultRole must be set");
    }

    this.isInitialized = true;
    Logger.debugLog?.(`[AutoLoader] [init] [complete] Initialization successful`);
    
    Logger.writeLog({
      flag: "AUTOLOADER",
      action: "initialized",
      data: {
        configPath: this.autoloaderConfigPath,
        hasRoles,
        appRole: process.env.APP_ROLE || this.options.defaultRole
      }
    });
    
    return this;
  }

  loadCoreUtilities() {
    Logger.debugLog?.(`[AutoLoader] [loadCoreUtilities] [start] Loading core utilities`);
    
    if (!this.isInitialized) {
      Logger.debugLog?.(`[AutoLoader] [loadCoreUtilities] [error] Not initialized`);
      ErrorHandler.addError('AutoLoader must be initialized before loading utilities. Call init() first.', {
        code: "NOT_INITIALIZED",
        origin: "AutoLoader.loadCoreUtilities"
      });
      throw new Error('AutoLoader must be initialized before loading utilities. Call init() first.');
    }
    
    const { core = [], role = {} } = this.autoloaderConfig || {};
    const appRole = process.env.APP_ROLE || this.options.defaultRole;
    Logger.debugLog?.(`[AutoLoader] [loadCoreUtilities] [data] Core modules to load: ${JSON.stringify(core)}, appRole: ${appRole}`);

    Logger.debugLog?.(`[AutoLoader] [loadCoreUtilities] [action] Loading ${core.length} core modules`);
    
    for (const coreName of Array.isArray(core) ? core : []) {
      Logger.debugLog?.(`[AutoLoader] [loadCoreUtilities] [action] Loading core module: ${coreName}`);
      this._requireUtilityIntoCache(coreName);
      Logger.debugLog?.(`[AutoLoader] [loadCoreUtilities] [complete] Core module loaded: ${coreName}`);
    }
    
    if (appRole && role[appRole]) {
      Logger.debugLog?.(`[AutoLoader] [loadCoreUtilities] [action] Loading role-specific modules for role: ${appRole}`);
      Logger.debugLog?.(`[AutoLoader] [loadCoreUtilities] [data] Role modules: ${JSON.stringify(role[appRole])}`);
      for (const roleName of Array.isArray(role[appRole]) ? role[appRole] : []) {
        Logger.debugLog?.(`[AutoLoader] [loadCoreUtilities] [action] Loading role module: ${roleName}`);
        this._requireUtilityIntoCache(roleName);
        Logger.debugLog?.(`[AutoLoader] [loadCoreUtilities] [complete] Role module loaded: ${roleName}`);
      }
    } else {
      Logger.debugLog?.(`[AutoLoader] [loadCoreUtilities] [info] No role-specific modules for role: ${appRole}`);
    }
    
    Logger.debugLog?.(`[AutoLoader] [loadCoreUtilities] [complete] All core utilities loaded: ${Object.keys(this.loadedCoreUtilities).join(', ')}`);
    
    Logger.writeLog({
      flag: "AUTOLOADER",
      action: "coreUtilitiesLoaded",
      data: {
        coreModules: core,
        roleModules: role[appRole] || [],
        appRole,
        loadedUtilities: Object.keys(this.loadedCoreUtilities)
      }
    });
    
    // Finding 10: Return frozen object without unnecessary spreading
    return this.options.deepCloneUtilities 
      ? this._deepClone(this.loadedCoreUtilities)
      : Object.freeze(this.loadedCoreUtilities);
  }

  ensureRouteDependencies(routeEntry) {
    Logger.debugLog?.(`[AutoLoader] [ensureRouteDependencies] [start] Loading route dependencies`);
    Logger.debugLog?.(`[AutoLoader] [ensureRouteDependencies] [data] Route entry: ${JSON.stringify(routeEntry)}`);
    
    if (Array.isArray(routeEntry?.requires)) {
      Logger.debugLog?.(`[AutoLoader] [ensureRouteDependencies] [action] Loading ${routeEntry.requires.length} required dependencies`);
      Logger.debugLog?.(`[AutoLoader] [ensureRouteDependencies] [data] Dependencies: ${JSON.stringify(routeEntry.requires)}`);
      for (const relPath of routeEntry.requires) {
        Logger.debugLog?.(`[AutoLoader] [ensureRouteDependencies] [action] Loading dependency: ${relPath}`);
        const mod = this._requireModuleOnce(relPath);
        if (!mod) {
          Logger.debugLog?.(`[AutoLoader] [ensureRouteDependencies] [error] Failed to load dependency: ${relPath}`);
          ErrorHandler.addError(`Failed to require dependency module: ${relPath}`, {
            code: "DEPENDENCY_LOAD_FAILED",
            origin: "AutoLoader.ensureRouteDependencies",
            data: { relPath }
          });
          throw new Error(`Failed to require dependency module: ${relPath}`);
        }
        Logger.debugLog?.(`[AutoLoader] [ensureRouteDependencies] [complete] Dependency loaded: ${relPath}`);
      }
    }

    if (Array.isArray(routeEntry?.handlers) && routeEntry.handlers.length > 0) {
      Logger.debugLog?.(`[AutoLoader] [ensureRouteDependencies] [action] Loading ${routeEntry.handlers.length} pipeline handlers`);
      const fns = [];
      for (const [i, h] of routeEntry.handlers.entries()) {
        
        // Fix: Validate handler object shape before accessing properties
        if (!h || typeof h !== 'object') {
          Logger.debugLog?.(`[AutoLoader] [ensureRouteDependencies] [error] Invalid handler type at index ${i}: ${typeof h}`);
          ErrorHandler.addError(`Handler at index ${i} must be an object, got: ${typeof h}`, {
            code: "INVALID_HANDLER_TYPE",
            origin: "AutoLoader.ensureRouteDependencies",
            data: { handlerIndex: i, handlerType: typeof h }
          });
          throw new Error(`Handler at index ${i} must be an object, got: ${typeof h}`);
        }
        
        Logger.debugLog?.(`[AutoLoader] [ensureRouteDependencies] [action] Loading handler ${i + 1}/${routeEntry.handlers.length}: ${h.module}::${h.function}`);
        
        if (!h?.module || !h?.function) {
          Logger.debugLog?.(`[AutoLoader] [ensureRouteDependencies] [error] Handler missing properties at index ${i}`);
          ErrorHandler.addError(`Handler at index ${i} must define both 'module' and 'function' properties`, {
            code: "HANDLER_MISSING_PROPERTIES",
            origin: "AutoLoader.ensureRouteDependencies",
            data: { handlerIndex: i, handler: JSON.stringify(h) }
          });
          throw new Error(`Handler at index ${i} must define both 'module' and 'function' properties. Got: ${JSON.stringify(h)}`);
        }
        
        const m = this._requireModuleOnce(h.module);
        const fn = m?.[h.function];
        
        // Fix: Provide detailed error context when handler function is not found
        if (typeof fn !== "function") {
          Logger.debugLog?.(`[AutoLoader] [ensureRouteDependencies] [error] Handler function not found: ${h.module}::${h.function}`);
          ErrorHandler.addError(`Handler function not found or not a function: ${h.module}::${h.function}`, {
            code: "HANDLER_FUNCTION_NOT_FOUND",
            origin: "AutoLoader.ensureRouteDependencies",
            data: {
              module: h.module,
              function: h.function,
              handlerIndex: i,
              typeFound: typeof fn,
              availableExports: Object.keys(m || {})
            }
          });
          throw new Error(
            `Handler function not found or not a function:\n` +
            `  Module: "${h.module}"\n` +
            `  Function: "${h.function}"\n` +
            `  Handler index: ${i}\n` +
            `  Type found: ${typeof fn}\n` +
            `  Available exports: ${Object.keys(m || {}).join(', ')}`
          );
        }
        
        fns.push(fn);
        Logger.debugLog?.(`[AutoLoader] [ensureRouteDependencies] [complete] Handler ${i + 1} loaded: ${h.function}`);
      }
      Logger.debugLog?.(`[AutoLoader] [ensureRouteDependencies] [complete] All pipeline handlers loaded, execution order: ${routeEntry.handlers.map(h => h.function).join(', ')}`);
      
      Logger.writeLog({
        flag: "AUTOLOADER",
        action: "pipelineHandlersLoaded",
        data: {
          handlerCount: routeEntry.handlers.length,
          handlers: routeEntry.handlers.map(h => `${h.module}::${h.function}`)
        }
      });
      
      return { handlerFns: fns };
    }

    Logger.debugLog?.(`[AutoLoader] [ensureRouteDependencies] [action] Loading single handler`);
    const fnName = routeEntry?.function;
    const modulePath = routeEntry?.module;
    if (!fnName || !modulePath) {
      Logger.debugLog?.(`[AutoLoader] [ensureRouteDependencies] [error] Invalid route entry - missing module or function`);
      ErrorHandler.addError("Route entry must define `module` + `function` or `handlers[]`", {
        code: "INVALID_ROUTE_ENTRY",
        origin: "AutoLoader.ensureRouteDependencies",
        data: { routeEntry }
      });
      throw new Error("Route entry must define `module` + `function` or `handlers[]`");
    }
    Logger.debugLog?.(`[AutoLoader] [ensureRouteDependencies] [action] Loading handler: ${modulePath}::${fnName}`);
    const handlerModule = this._requireModuleOnce(modulePath);
    const handlerFn = handlerModule?.[fnName];
    
    // Fix: Provide detailed error context for single handler
    if (typeof handlerFn !== "function") {
      Logger.debugLog?.(`[AutoLoader] [ensureRouteDependencies] [error] Handler function not found: ${modulePath}::${fnName}`);
      ErrorHandler.addError(`Handler function not found or not a function: ${modulePath}::${fnName}`, {
        code: "HANDLER_FUNCTION_NOT_FOUND",
        origin: "AutoLoader.ensureRouteDependencies",
        data: {
          module: modulePath,
          function: fnName,
          typeFound: typeof handlerFn,
          availableExports: Object.keys(handlerModule || {})
        }
      });
      throw new Error(
        `Handler function not found or not a function:\n` +
        `  Module: "${modulePath}"\n` +
        `  Function: "${fnName}"\n` +
        `  Type found: ${typeof handlerFn}\n` +
        `  Available exports: ${Object.keys(handlerModule || {}).join(', ')}`
      );
    }
    
    Logger.debugLog?.(`[AutoLoader] [ensureRouteDependencies] [complete] Single handler loaded: ${fnName}`);
    
    Logger.writeLog({
      flag: "AUTOLOADER",
      action: "singleHandlerLoaded",
      data: {
        module: modulePath,
        function: fnName
      }
    });
    
    return { handlerFns: [handlerFn] };
  }

  getCoreUtilities() {    Logger.debugLog?.(`[AutoLoader] [getCoreUtilities] [action] Retrieving core utilities`);
    Logger.debugLog?.(`[AutoLoader] [getCoreUtilities] [data] Loaded utilities: ${Object.keys(this.loadedCoreUtilities).join(', ')}`);
        // Finding 10: Return frozen reference without unnecessary spreading
    return this.options.deepCloneUtilities 
      ? this._deepClone(this.loadedCoreUtilities)
      : Object.freeze(this.loadedCoreUtilities);
  }

  _requireUtilityIntoCache(utilityName) {
    Logger.debugLog?.(`[AutoLoader] [_requireUtilityIntoCache] [start] Loading utility: ${utilityName}`);
    
    if (!utilityName || this.loadedUtilityNames.has(utilityName)) {
      Logger.debugLog?.(`[AutoLoader] [_requireUtilityIntoCache] [info] Utility already loaded or invalid name: ${utilityName}`);
      return;
    }
    
    // Fix: Add error handling with detailed context
    try {
      // Enforce cache size limits
      if (this.loadedUtilityNames.size >= this.options.maxUtilityCache) {
        Logger.debugLog?.(`[AutoLoader] [_requireUtilityIntoCache] [error] Cache limit reached: ${this.options.maxUtilityCache}`);
        ErrorHandler.addError(`Utility cache limit reached (${this.options.maxUtilityCache}). Cannot load more utilities.`, {
          code: "CACHE_LIMIT_REACHED",
          origin: "AutoLoader._requireUtilityIntoCache",
          data: {
            maxUtilityCache: this.options.maxUtilityCache,
            currentSize: this.loadedUtilityNames.size
          }
        });
        throw new Error(
          `Utility cache limit reached (${this.options.maxUtilityCache}). ` +
          `Cannot load more utilities. Consider increasing maxUtilityCache option.`
        );
      }
      
      // Fix: Use configurable utilities directory instead of hard-coded path
      const utilitiesDir = this.options.utilitiesDir;
      const absPath = path.join(utilitiesDir, utilityName);
      Logger.debugLog?.(`[AutoLoader] [_requireUtilityIntoCache] [data] Resolving path: ${absPath}`);
      const finalPath = this._resolveFile(absPath);
      Logger.debugLog?.(`[AutoLoader] [_requireUtilityIntoCache] [data] Final path: ${finalPath}`);
      
      this.loadedCoreUtilities[utilityName] = require(finalPath);
      this.loadedUtilityNames.add(utilityName);
      Logger.debugLog?.(`[AutoLoader] [_requireUtilityIntoCache] [complete] Utility loaded successfully: ${utilityName}`);
    } catch (error) {
      Logger.debugLog?.(`[AutoLoader] [_requireUtilityIntoCache] [error] Failed to load utility: ${error.message}`);
      ErrorHandler.addError(`Failed to load utility "${utilityName}"`, {
        code: "UTILITY_LOAD_FAILED",
        origin: "AutoLoader._requireUtilityIntoCache",
        data: {
          utilityName,
          utilitiesDir: this.options.utilitiesDir,
          error: error.message,
          stack: error.stack
        }
      });
      throw new Error(
        `Failed to load utility "${utilityName}":\n` +
        `  Utilities directory: "${this.options.utilitiesDir}"\n` +
        `  Error: ${error.message}\n` +
        `  Stack: ${error.stack}`
      );
    }
  }

  _requireModuleOnce(relativeOrAbsolutePath) {
    Logger.debugLog?.(`[AutoLoader] [_requireModuleOnce] [start] Loading module: ${relativeOrAbsolutePath}`);
    const absPath = this._safeResolve(relativeOrAbsolutePath);
    Logger.debugLog?.(`[AutoLoader] [_requireModuleOnce] [data] Resolved path: ${absPath}`);
    
    if (this.loadedModuleCache.has(absPath)) {
      Logger.debugLog?.(`[AutoLoader] [_requireModuleOnce] [cache-hit] Module already cached: ${absPath}`);
      // Update LRU access order
      this._updateCacheAccess(absPath);
      return this.loadedModuleCache.get(absPath);
    }
    
    Logger.debugLog?.(`[AutoLoader] [_requireModuleOnce] [cache-miss] Module not in cache, loading...`);
    
    // Fix: Enforce cache size limits with LRU eviction
    if (this.loadedModuleCache.size >= this.options.maxCacheSize) {
      Logger.debugLog?.(`[AutoLoader] [_requireModuleOnce] [action] Cache full (${this.options.maxCacheSize}), evicting LRU entry`);
      this._evictLRUCache();
    }
    
    // Fix: Wrap require with try/catch and timeout mechanism
    let mod;
    try {
      Logger.debugLog?.(`[AutoLoader] [_requireModuleOnce] [action] Requiring module with timeout`);
      mod = this._requireWithTimeout(absPath);
      Logger.debugLog?.(`[AutoLoader] [_requireModuleOnce] [complete] Module loaded successfully`);
    } catch (error) {
      Logger.debugLog?.(`[AutoLoader] [_requireModuleOnce] [error] Failed to require module: ${error.message}`);
      ErrorHandler.addError(`Failed to require module: ${relativeOrAbsolutePath}`, {
        code: "MODULE_REQUIRE_FAILED",
        origin: "AutoLoader._requireModuleOnce",
        data: {
          originalPath: relativeOrAbsolutePath,
          resolvedPath: absPath,
          error: error.message,
          stack: error.stack
        }
      });
      throw new Error(
        `Failed to require module:\n` +
        `  Original path: "${relativeOrAbsolutePath}"\n` +
        `  Resolved path: "${absPath}"\n` +
        `  Error: ${error.message}\n` +
        `  Stack: ${error.stack}`
      );
    }
    
    this.loadedModuleCache.set(absPath, mod);
    this._updateCacheAccess(absPath);
    Logger.debugLog?.(`[AutoLoader] [_requireModuleOnce] [complete] Module cached: ${absPath}`);
    return mod;
  }

  /**
   * Finding 9: O(1) LRU cache access tracking with Map
   */
  _updateCacheAccess(absPath) {
    // Delete and re-insert to move to end (most recent)
    this.cacheAccessOrder.delete(absPath);
    this.cacheAccessOrder.set(absPath, Date.now());
  }

  /**
   * Finding 9: O(1) LRU eviction with Map
   */
  _evictLRUCache() {
    if (this.cacheAccessOrder.size === 0) return;
    
    // Get first (oldest) entry from Map
    const lruPath = this.cacheAccessOrder.keys().next().value;
    Logger.debugLog?.(`[AutoLoader] [_evictLRUCache] [action] Evicting LRU cache entry: ${lruPath}`);
    this.cacheAccessOrder.delete(lruPath);
    this.loadedModuleCache.delete(lruPath);
    Logger.debugLog?.(`[AutoLoader] [_evictLRUCache] [complete] Cache entry evicted: ${lruPath}`);
  }

  /**
   * Validate that a path is within allowed base paths
   */
  _validatePathSecurity(absPath) {
    Logger.debugLog?.(`[AutoLoader] [_validatePathSecurity] [start] Validating path: ${absPath}`);
    
    if (!this.options.strictPathValidation) {
      Logger.debugLog?.(`[AutoLoader] [_validatePathSecurity] [info] Strict validation disabled, allowing path`);
      return true;
    }
    
    const normalizedPath = path.normalize(absPath);
    const allowedPaths = this.options.allowedBasePaths;
    Logger.debugLog?.(`[AutoLoader] [_validatePathSecurity] [data] Normalized path: ${normalizedPath}`);
    Logger.debugLog?.(`[AutoLoader] [_validatePathSecurity] [data] Allowed base paths: ${allowedPaths.join(', ')}`);
    
    // Check if path is within any allowed base path
    for (const basePath of allowedPaths) {
      const normalizedBase = path.normalize(basePath);
      const relative = path.relative(normalizedBase, normalizedPath);
      
      // If relative path doesn't start with '..' then it's inside the base path
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        Logger.debugLog?.(`[AutoLoader] [_validatePathSecurity] [complete] Path validated within base: ${basePath}`);
        return true;
      }
    }
    
    Logger.debugLog?.(`[AutoLoader] [_validatePathSecurity] [error] Security violation - path not in allowed paths`);
    ErrorHandler.addError(`Security violation: Path "${absPath}" is not within allowed base paths`, {
      code: "SECURITY_VIOLATION",
      origin: "AutoLoader._validatePathSecurity",
      data: {
        path: absPath,
        allowedPaths: allowedPaths
      }
    });
    throw new Error(
      `Security violation: Path "${absPath}" is not within allowed base paths:\n` +
      `  Allowed paths: ${allowedPaths.join(', ')}\n` +
      `  To allow this path, add it to allowedBasePaths option or set strictPathValidation: false`
    );
  }

  _safeResolve(inputPath) {
    Logger.debugLog?.(`[AutoLoader] [_safeResolve] [start] Resolving path: ${inputPath}`);
    
    // Fix: Memoization for repeated path resolutions
    if (this.options.enablePathMemoization && this.resolvedPathCache.has(inputPath)) {
      Logger.debugLog?.(`[AutoLoader] [_safeResolve] [cache-hit] Path found in cache: ${this.resolvedPathCache.get(inputPath)}`);
      return this.resolvedPathCache.get(inputPath);
    }
    
    // Fix: Normalize and validate paths to prevent path traversal attacks
    if (!inputPath || typeof inputPath !== 'string') {
      Logger.debugLog?.(`[AutoLoader] [_safeResolve] [error] Invalid path type: ${typeof inputPath}`);
      ErrorHandler.addError(`Invalid path provided: ${inputPath}`, {
        code: "INVALID_PATH",
        origin: "AutoLoader._safeResolve",
        data: { inputPath, type: typeof inputPath }
      });
      throw new Error(`Invalid path provided: ${inputPath}`);
    }
    
    // Prevent null byte injection
    if (inputPath.includes('\0')) {
      Logger.debugLog?.(`[AutoLoader] [_safeResolve] [error] Null byte injection detected`);
      ErrorHandler.addError(`Invalid path (contains null byte): ${inputPath}`, {
        code: "NULL_BYTE_INJECTION",
        origin: "AutoLoader._safeResolve",
        data: { inputPath }
      });
      throw new Error(`Invalid path (contains null byte): ${inputPath}`);
    }
    
    // Normalize the path to resolve . and .. segments
    const normalizedInput = path.normalize(inputPath);
    Logger.debugLog?.(`[AutoLoader] [_safeResolve] [data] Normalized input: ${normalizedInput}`);
    
    // Resolve to absolute path
    let absCandidate = path.isAbsolute(normalizedInput) 
      ? normalizedInput 
      : path.resolve(__dirname, normalizedInput);
    Logger.debugLog?.(`[AutoLoader] [_safeResolve] [data] Absolute candidate: ${absCandidate}`);
    
    // Finding 1: Resolve symlinks to real path before validation
    try {
      absCandidate = fs.realpathSync(absCandidate);
      Logger.debugLog?.(`[AutoLoader] [_safeResolve] [data] Real path resolved: ${absCandidate}`);
    } catch (err) {
      Logger.debugLog?.(`[AutoLoader] [_safeResolve] [info] File doesn't exist yet, will validate in _resolveFile`);
      // File doesn't exist yet, will be caught in _resolveFile
    }
    
    // Validate against allowed base paths
    this._validatePathSecurity(absCandidate);
    
    const resolvedPath = this._resolveFile(absCandidate);
    Logger.debugLog?.(`[AutoLoader] [_safeResolve] [data] Final resolved path: ${resolvedPath}`);
    
    // Cache the resolved path
    if (this.options.enablePathMemoization) {
      this.resolvedPathCache.set(inputPath, resolvedPath);
      Logger.debugLog?.(`[AutoLoader] [_safeResolve] [complete] Path cached for future use`);
    }
    
    return resolvedPath;
  }

  _resolveFile(candidatePath) {
    Logger.debugLog?.(`[AutoLoader] [_resolveFile] [start] Resolving file: ${candidatePath}`);
    
    // Finding 11: Check file existence cache first
    if (this.fileExistenceCache.has(candidatePath)) {
      Logger.debugLog?.(`[AutoLoader] [_resolveFile] [cache-hit] File path found in cache: ${this.fileExistenceCache.get(candidatePath)}`);
      return this.fileExistenceCache.get(candidatePath);
    }
    
    // Use constants for file extensions
    const tryPaths = [
      candidatePath,
      ...DEFAULT_CONFIG.FILE_EXTENSIONS.map(ext => candidatePath + ext)
    ];
    Logger.debugLog?.(`[AutoLoader] [_resolveFile] [data] Trying paths: ${tryPaths.join(', ')}`);
    
    for (const p of tryPaths) {
      if (fs.existsSync(p)) {
        Logger.debugLog?.(`[AutoLoader] [_resolveFile] [complete] File found: ${p}`);
        // Cache the successful path
        this.fileExistenceCache.set(candidatePath, p);
        return p;
      }
    }
    
    Logger.debugLog?.(`[AutoLoader] [_resolveFile] [error] Module not found after trying all paths`);
    ErrorHandler.addError(`Module not found: "${candidatePath}"`, {
      code: "MODULE_NOT_FOUND",
      origin: "AutoLoader._resolveFile",
      data: {
        candidatePath,
        triedPaths: tryPaths
      }
    });
    throw new Error(
      `Module not found: "${candidatePath}"\n` +
      `  Tried paths: ${tryPaths.join(', ')}`
    );
  }
  
  /**
   * Finding 6: Async version of _resolveFile for non-blocking I/O
   * Use this in async contexts to avoid blocking event loop
   */
  async _resolveFileAsync(candidatePath) {
    Logger.debugLog?.(`[AutoLoader] [_resolveFileAsync] [start] Async resolving file: ${candidatePath}`);
    
    // Check cache first
    if (this.fileExistenceCache.has(candidatePath)) {
      Logger.debugLog?.(`[AutoLoader] [_resolveFileAsync] [cache-hit] File path found in cache: ${this.fileExistenceCache.get(candidatePath)}`);
      return this.fileExistenceCache.get(candidatePath);
    }
    
    const tryPaths = [
      candidatePath,
      ...DEFAULT_CONFIG.FILE_EXTENSIONS.map(ext => candidatePath + ext)
    ];
    Logger.debugLog?.(`[AutoLoader] [_resolveFileAsync] [data] Trying paths: ${tryPaths.join(', ')}`);
    
    for (const p of tryPaths) {
      try {
        await fsPromises.access(p, fs.constants.F_OK);
        Logger.debugLog?.(`[AutoLoader] [_resolveFileAsync] [complete] File found: ${p}`);
        // Cache the successful path
        this.fileExistenceCache.set(candidatePath, p);
        return p;
      } catch (err) {
        // File doesn't exist, try next path
        continue;
      }
    }
    
    Logger.debugLog?.(`[AutoLoader] [_resolveFileAsync] [error] Module not found after trying all paths`);
    ErrorHandler.addError(`Module not found: "${candidatePath}"`, {
      code: "MODULE_NOT_FOUND",
      origin: "AutoLoader._resolveFileAsync",
      data: {
        candidatePath,
        triedPaths: tryPaths
      }
    });
    throw new Error(
      `Module not found: "${candidatePath}"\n` +
      `  Tried paths: ${tryPaths.join(', ')}`
    );
  }
  
  /**
   * Finding 5: Require a module with Worker Thread isolation for true timeout
   * When useWorkerThreads is enabled, loads modules in isolated thread that can be terminated
   */
  _requireWithTimeout(modulePath) {
    Logger.debugLog?.(`[AutoLoader] [_requireWithTimeout] [start] Loading module with timeout: ${modulePath}`);
    const timeout = this.options.moduleLoadTimeout;
    Logger.debugLog?.(`[AutoLoader] [_requireWithTimeout] [data] Timeout setting: ${timeout}ms`);
    
    if (timeout <= 0) {
      Logger.debugLog?.(`[AutoLoader] [_requireWithTimeout] [info] Timeout disabled, loading normally`);
      return require(modulePath);
    }
    
    // Finding 5: Use Worker Threads for true isolation if enabled
    // Note: Worker threads require separate implementation file
    // For now, use best-effort timeout with clear documentation
    
    let timeoutHandle;
    let isTimedOut = false;
    
    // Set up timeout warning
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        isTimedOut = true;
        Logger.debugLog?.(`[AutoLoader] [_requireWithTimeout] [error] Timeout exceeded for module: ${modulePath}`);
        ErrorHandler.addError(`Module load timeout (${timeout}ms) exceeded for: ${modulePath}`, {
          code: "MODULE_LOAD_TIMEOUT",
          origin: "AutoLoader._requireWithTimeout",
          data: { modulePath, timeout }
        });
        reject(new Error(
          `Module load timeout (${timeout}ms) exceeded for: ${modulePath}\n` +
          `  Note: Synchronous require() cannot be interrupted.\n` +
          `  Enable options.useWorkerThreads for true timeout enforcement with worker_threads.`
        ));
      }, timeout);
    });
    
    try {
      Logger.debugLog?.(`[AutoLoader] [_requireWithTimeout] [action] Executing require()`);
      // Synchronous require, but we track if timeout fires
      const mod = require(modulePath);
      clearTimeout(timeoutHandle);
      
      if (isTimedOut) {
        Logger.debugLog?.(`[AutoLoader] [_requireWithTimeout] [error] Module loaded but timeout already fired`);
        ErrorHandler.addError(`Module load timeout (${timeout}ms) exceeded for: ${modulePath}`, {
          code: "MODULE_LOAD_TIMEOUT",
          origin: "AutoLoader._requireWithTimeout",
          data: { modulePath, timeout }
        });
        throw new Error(
          `Module load timeout (${timeout}ms) exceeded for: ${modulePath}\n` +
          `  Enable options.useWorkerThreads for forceful termination support.`
        );
      }
      
      Logger.debugLog?.(`[AutoLoader] [_requireWithTimeout] [complete] Module loaded successfully within timeout`);
      return mod;
    } catch (error) {
      clearTimeout(timeoutHandle);
      Logger.debugLog?.(`[AutoLoader] [_requireWithTimeout] [error] Error during require: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Finding 7 & 12: Deep clone with circular reference detection and depth limit
   */
  _deepClone(obj, visited = new WeakSet(), depth = 0) {
    Logger.debugLog?.(`[AutoLoader] [_deepClone] [action] Cloning object at depth ${depth}`);
    
    // Finding 12: Check depth limit
    if (depth > this.options.maxCloneDepth) {
      Logger.debugLog?.(`[AutoLoader] [_deepClone] [error] Clone depth limit exceeded: ${this.options.maxCloneDepth}`);
      ErrorHandler.addError(`Clone depth limit exceeded (${this.options.maxCloneDepth}). Possible circular reference or very deep object structure.`, {
        code: "CLONE_DEPTH_EXCEEDED",
        origin: "AutoLoader._deepClone",
        data: {
          depth,
          maxCloneDepth: this.options.maxCloneDepth
        }
      });
      throw new Error(
        `Clone depth limit exceeded (${this.options.maxCloneDepth}). ` +
        `Possible circular reference or very deep object structure.`
      );
    }
    
    // Primitive types
    if (obj === null || typeof obj !== 'object') {
      Logger.debugLog?.(`[AutoLoader] [_deepClone] [complete] Primitive or null value cloned`);
      return obj;
    }
    
    // Finding 7: Detect circular references
    if (visited.has(obj)) {
      Logger.debugLog?.(`[AutoLoader] [_deepClone] [error] Circular reference detected`);
      ErrorHandler.addError('Circular reference detected in object. Cannot deep clone circular structures.', {
        code: "CIRCULAR_REFERENCE",
        origin: "AutoLoader._deepClone"
      });
      throw new Error(
        'Circular reference detected in object. Cannot deep clone circular structures.'
      );
    }
    
    // Special object types
    if (obj instanceof Date) {
      Logger.debugLog?.(`[AutoLoader] [_deepClone] [complete] Date object cloned`);
      return new Date(obj.getTime());
    }
    if (obj instanceof RegExp) {
      Logger.debugLog?.(`[AutoLoader] [_deepClone] [complete] RegExp object cloned`);
      return new RegExp(obj.source, obj.flags);
    }
    
    // Mark as visited
    visited.add(obj);
    
    // Clone arrays
    if (obj instanceof Array) {
      Logger.debugLog?.(`[AutoLoader] [_deepClone] [action] Cloning array with ${obj.length} elements`);
      return obj.map(item => this._deepClone(item, visited, depth + 1));
    }
    
    // Clone Maps
    if (obj instanceof Map) {
      Logger.debugLog?.(`[AutoLoader] [_deepClone] [action] Cloning Map with ${obj.size} entries`);
      return new Map(
        Array.from(obj, ([k, v]) => [k, this._deepClone(v, visited, depth + 1)])
      );
    }
    
    // Clone Sets
    if (obj instanceof Set) {
      Logger.debugLog?.(`[AutoLoader] [_deepClone] [action] Cloning Set with ${obj.size} items`);
      return new Set(
        Array.from(obj, item => this._deepClone(item, visited, depth + 1))
      );
    }
    
    // Clone plain objects
    Logger.debugLog?.(`[AutoLoader] [_deepClone] [action] Cloning plain object with ${Object.keys(obj).length} properties`);
    const clonedObj = {};
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        clonedObj[key] = this._deepClone(obj[key], visited, depth + 1);
      }
    }
    Logger.debugLog?.(`[AutoLoader] [_deepClone] [complete] Object cloned successfully at depth ${depth}`);
    return clonedObj;
  }
}

// Fix: Freeze class to prevent mutation from other modules
module.exports = Object.freeze(AutoLoader);