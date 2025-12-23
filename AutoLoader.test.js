const path = require("path");
const fs = require("fs");

jest.mock("fs");
jest.mock("path", () => ({
  ...jest.requireActual("path"),
  resolve: jest.fn((...args) => args.join("/")),
  isAbsolute: jest.fn((p) => p.startsWith("/")),
  join: jest.fn((...args) => args.join("/")),
}));

describe("AutoLoader Class", () => {
  const mockRequire = jest.fn();
  const configPath = "/mock/path/config.js";
  const mockConfig = {
    core: ["coreA"],
    role: {
      admin: ["adminUtil"],
    },
  };

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    fs.existsSync.mockReturnValue(true);
    jest.doMock(configPath, () => mockConfig, { virtual: true });
    process.env.APP_ROLE = "admin";
  });

  const AutoLoader = require("./AutoLoader"); // adjust path

  // constructor
  test("PASS_constructor_1: valid config path", () => {
    const loader = new AutoLoader({ autoloaderConfigPath: configPath });
    expect(loader.autoloaderConfig).toEqual(mockConfig);
  });

  test("FAIL_constructor_1: missing config path throws", () => {
    expect(() => new AutoLoader({})).toThrow(/autoloaderConfigPath/);
  });

  test("FAIL_constructor_2: missing APP_ROLE throws when required", () => {
    delete process.env.APP_ROLE;
    expect(() => new AutoLoader({ autoloaderConfigPath: configPath })).toThrow(
      /APP_ROLE/
    );
  });

  // getCoreUtilities
  test("PASS_getCore_1: returns shallow copy", () => {
    const loader = new AutoLoader({ autoloaderConfigPath: configPath });
    loader.loadedCoreUtilities = { a: 1 };
    const utils = loader.getCoreUtilities();
    expect(utils).toEqual({ a: 1 });
    expect(utils).not.toBe(loader.loadedCoreUtilities); // shallow copy
  });

  // loadCoreUtilities
  test("PASS_loadCore_1: loads core and role modules", () => {
    const loader = new AutoLoader({ autoloaderConfigPath: configPath });
    loader._requireUtilityIntoCache = jest.fn();
    loader.loadCoreUtilities();
    expect(loader._requireUtilityIntoCache).toHaveBeenCalledWith("coreA");
    expect(loader._requireUtilityIntoCache).toHaveBeenCalledWith("adminUtil");
  });

  test("PASS_loadCore_2: skips role modules when role not set", () => {
      process.env.APP_ROLE = "undefinedRole";
    const loader = new AutoLoader({ autoloaderConfigPath: configPath });
    loader._requireUtilityIntoCache = jest.fn();
    loader.loadCoreUtilities();
    expect(loader._requireUtilityIntoCache).toHaveBeenCalledWith("coreA");
  });

  // ensureRouteDependencies
  test("PASS_ensureRoute_1: loads single handler", () => {
    const loader = new AutoLoader({ autoloaderConfigPath: configPath });
    const fakeFn = jest.fn();
    loader._requireModuleOnce = jest.fn(() => ({ myFn: fakeFn }));
    const out = loader.ensureRouteDependencies({
      module: "mod.js",
      function: "myFn",
    });
    expect(out.handlerFns[0]).toBe(fakeFn);
  });

  test("PASS_ensureRoute_2: loads multiple handlers", () => {
    const loader = new AutoLoader({ autoloaderConfigPath: configPath });
    const fn1 = jest.fn(),
      fn2 = jest.fn();
    loader._requireModuleOnce = jest.fn(() => ({ fn1, fn2 }));
    const out = loader.ensureRouteDependencies({
      requires: ["dep1.js"],
      handlers: [
        { module: "mod.js", function: "fn1" },
        { module: "mod.js", function: "fn2" },
      ],
    });
    expect(out.handlerFns).toEqual([fn1, fn2]);
  });

  test("FAIL_ensureRoute_1: missing function in module throws", () => {
    const loader = new AutoLoader({ autoloaderConfigPath: configPath });
    loader._requireModuleOnce = jest.fn(() => ({}));
    expect(() =>
      loader.ensureRouteDependencies({ module: "x.js", function: "missing" })
    ).toThrow(/not found/);
  });

  test("FAIL_ensureRoute_2: malformed handler throws", () => {
    const loader = new AutoLoader({ autoloaderConfigPath: configPath });
    expect(() =>
      loader.ensureRouteDependencies({ handlers: [{ module: "x.js" }] })
    ).toThrow(/must define/);
  });

  // _requireModuleOnce
  test("PASS_requireOnce_1: caches module", () => {
    const loader = new AutoLoader({ autoloaderConfigPath: configPath });
    const mod = { x: 1 };
    loader._safeResolve = jest.fn(() => "abs.js");
    jest.mock("abs.js", () => mod, { virtual: true });
    loader.loadedModuleCache.set("abs.js", mod);
    const loaded = loader._requireModuleOnce("abs.js");
    expect(loaded).toBe(mod);
  });

  test("FAIL_requireOnce_1: missing file throws", () => {
    const loader = new AutoLoader({ autoloaderConfigPath: configPath });
    loader._safeResolve = () => {
      throw new Error("Not found");
    };
    expect(() => loader._requireModuleOnce("nope.js")).toThrow(/Not found/);
  });
});
