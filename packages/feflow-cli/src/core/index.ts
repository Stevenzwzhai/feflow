import Commander from './commander';
import Hook from './hook';
import Binp from './universal-pkg/binp';
import fs from 'fs';
import inquirer from 'inquirer';
import logger from './logger';
import osenv from 'osenv';
import path from 'path';
import Table from 'easy-table';
import spawn from 'cross-spawn';
import loadPlugins from './plugin/loadPlugins';
import loadUniversalPlugin from './plugin/loadUniversalPlugin';
import loadDevkits from './devkit/loadDevkits';
import getCommandLine from './devkit/commandOptions';
import {
  FEFLOW_ROOT,
  FEFLOW_BIN,
  FEFLOW_LIB,
  UNIVERSAL_PKG_JSON,
  UNIVERSAL_MODULES,
  HOOK_TYPE_ON_COMMAND_REGISTERED
} from '../shared/constant';
import { safeDump, parseYaml } from '../shared/yaml';
import packageJson from '../shared/packageJson';
import { getRegistryUrl, install } from '../shared/npm';
import chalk from 'chalk';
import semver from 'semver';
import commandLineUsage from 'command-line-usage';
import { UniversalPkg } from './universal-pkg/dep/pkg';
import Report from '@feflow/report';
import CommandPicker, {
  LOAD_UNIVERSAL_PLUGIN,
  LOAD_PLUGIN,
  LOAD_DEVKIT,
  LOAD_ALL
} from './command-picker';

const pkg = require('../../package.json');

export default class Feflow {
  public args: any;
  public cmd: any;
  public projectConfig: any;
  public projectPath: any;
  public version: string;
  public logger: any;
  public commander: any;
  public hook: any;
  public root: any;
  public rootPkg: any;
  public universalPkgPath: string;
  public universalModules: string;
  public config: any;
  public configPath: any;
  public bin: string;
  public lib: string;
  public universalPkg: UniversalPkg;
  public reporter: any;

  constructor(args: any) {
    args = args || {};
    const root = path.join(osenv.home(), FEFLOW_ROOT);
    const configPath = path.join(root, '.feflowrc.yml');
    this.root = root;
    const bin = path.join(root, FEFLOW_BIN);
    const lib = path.join(root, FEFLOW_LIB);
    this.bin = bin;
    this.lib = lib;
    this.rootPkg = path.join(root, 'package.json');
    this.universalPkgPath = path.join(root, UNIVERSAL_PKG_JSON);
    this.universalModules = path.join(root, UNIVERSAL_MODULES);
    this.args = args;
    this.version = pkg.version;
    this.config = parseYaml(configPath);
    this.configPath = configPath;
    this.hook = new Hook();
    this.commander = new Commander((cmdName: string) => {
      this.hook.emit(HOOK_TYPE_ON_COMMAND_REGISTERED, cmdName);
    });
    this.logger = logger({
      debug: Boolean(args.debug),
      silent: Boolean(args.silent)
    });
    this.reporter = new Report(this);
    this.universalPkg = new UniversalPkg(this.universalPkgPath);
    this.initBinPath();
  }

  async init(cmd: string) {
    this.reporter.init && this.reporter.init(cmd);

    await this.initClient();
    await this.initPackageManager();

    const disableCheck = this.args['disable-check'] || (this.config && this.config.disableCheck);

    if (!disableCheck) {
      await this.checkCliUpdate();
      await this.checkUpdate();
    }

    const picker = new CommandPicker(this, cmd);

    if (picker.isAvailable()) {
      // should hit the cache in most cases
      picker.pickCommand();
    } else {
      // if not, load plugin/devkit/native in need
      await this.loadCommands(picker.getLoadOrder());
      // make sure the command has at least one funtion, otherwise replace to help command
      picker.checkCommand();
    }
  }

  initClient() {
    const { root, rootPkg } = this;

    return new Promise<any>((resolve, reject) => {
      if (fs.existsSync(root) && fs.statSync(root).isFile()) {
        fs.unlinkSync(root);
      }

      if (!fs.existsSync(root)) {
        fs.mkdirSync(root);
      }

      if (!fs.existsSync(rootPkg)) {
        fs.writeFileSync(
          rootPkg,
          JSON.stringify(
            {
              name: 'feflow-home',
              version: '0.0.0',
              private: true
            },
            null,
            2
          )
        );
      }
      resolve();
    });
  }

  private initBinPath() {
    const { bin } = this;

    if (fs.existsSync(bin) && fs.statSync(bin).isFile()) {
      fs.unlinkSync(bin);
    }

    if (!fs.existsSync(bin)) {
      fs.mkdirSync(bin);
    }
    new Binp().register(bin);
  }

  initPackageManager() {
    const { root, logger } = this;

    return new Promise<any>((resolve, reject) => {
      if (!this.config || !this.config.packageManager) {
        const isInstalled = (packageName: string) => {
          try {
            const ret = spawn.sync(packageName, ['-v'], { stdio: 'ignore' });
            if (ret.status !== 0) {
              return false;
            }
            return true;
          } catch (err) {
            return false;
          }
        };

        const packageManagers = ['tnpm', 'cnpm', 'npm', 'yarn'];

        const installedPackageManagers = packageManagers.filter(
          packageManager => isInstalled(packageManager)
        );

        if (installedPackageManagers.length === 0) {
          const notify = 'You must installed a package manager';
          console.error(notify);
        } else {
          const defaultPackageManager = installedPackageManagers[0];
          const configPath = path.join(root, '.feflowrc.yml');
          safeDump(
            {
              packageManager: defaultPackageManager
            },
            configPath
          );
          this.config = parseYaml(configPath);
          resolve();
        }
        return;
      } else {
        logger.debug('Use packageManager is: ', this.config.packageManager);
      }
      resolve();
    });
  }

  checkUpdate() {
    const { root, rootPkg, config, logger } = this;
    if (!config) {
      return;
    }

    const table = new Table();
    const packageManager = config.packageManager;
    return Promise.all(
      this.getInstalledPlugins().map(async (name: any) => {
        const pluginPath = path.join(
          root,
          'node_modules',
          name,
          'package.json'
        );
        const content: any = fs.readFileSync(pluginPath);
        const pkg: any = JSON.parse(content);
        const localVersion = pkg.version;
        const registryUrl = await getRegistryUrl(packageManager);
        const latestVersion: any = await packageJson(name, registryUrl).catch(
          err => {
            logger.debug('Check plugin update error', err);
          }
        );

        if (latestVersion && semver.gt(latestVersion, localVersion)) {
          table.cell('Name', name);
          table.cell(
            'Version',
            localVersion === latestVersion
              ? localVersion
              : localVersion + ' -> ' + latestVersion
          );
          table.cell('Tag', 'latest');
          table.cell('Update', localVersion === latestVersion ? 'N' : 'Y');
          table.newRow();

          return {
            name,
            latestVersion
          };
        } else {
          logger.debug('All plugins is in latest version');
        }
      })
    ).then((plugins: any) => {
      plugins = plugins.filter((plugin: any) => {
        return plugin && plugin.name;
      });
      if (plugins.length) {
        this.logger.info(
          'It will update your local templates or plugins, this will take few minutes'
        );
        console.log(table.toString());

        this.updatePluginsVersion(rootPkg, plugins);

        const needUpdatePlugins: any = [];
        plugins.map((plugin: any) => {
          needUpdatePlugins.push(plugin.name);
        });

        return install(
          packageManager,
          root,
          packageManager === 'yarn' ? 'add' : 'install',
          needUpdatePlugins,
          false,
          true
        ).then(() => {
          this.logger.info('Plugin update success');
        });
      }
    });
  }

  updatePluginsVersion(packagePath: string, plugins: any) {
    const obj = require(packagePath);

    plugins.map((plugin: any) => {
      obj.dependencies[plugin.name] = plugin.latestVersion;
    });

    fs.writeFileSync(packagePath, JSON.stringify(obj, null, 4));
  }

  getInstalledPlugins() {
    const { root, rootPkg } = this;

    let plugins: any = [];
    const exist = fs.existsSync(rootPkg);
    const pluginDir = path.join(root, 'node_modules');

    if (!exist) {
      plugins = [];
    } else {
      const content: any = fs.readFileSync(rootPkg);

      let json: any;

      try {
        json = JSON.parse(content);
        const deps = json.dependencies || json.devDependencies || {};

        plugins = Object.keys(deps);
      } catch (ex) {
        plugins = [];
      }
    }
    return plugins.filter((name: any) => {
      if (
        !/^feflow-plugin-|^@[^/]+\/feflow-plugin-|generator-|^@[^/]+\/generator-/.test(
          name
        )
      ) {
        return false;
      }
      const pathFn = path.join(pluginDir, name);
      return fs.existsSync(pathFn);
    });
  }

  loadNative() {
    return new Promise<any>((resolve, reject) => {
      const nativePath = path.join(__dirname, './native');
      fs.readdirSync(nativePath)
        .filter((file) => {
          return file.endsWith('.js');
        })
        .map((file) => {
          require(path.join(__dirname, './native', file))(this);
        });
      resolve();
    });
  }

  async loadCommands(order: number) {
    this.logger.debug('load order: ', order);
    if ((order & LOAD_ALL) === LOAD_ALL) {
      await this.loadNative();
      await loadUniversalPlugin(this);
      await loadPlugins(this);
      await loadDevkits(this);
      return;
    }
    if ((order & LOAD_PLUGIN) === LOAD_PLUGIN) {
      await loadPlugins(this);
    }
    if ((order & LOAD_UNIVERSAL_PLUGIN) === LOAD_UNIVERSAL_PLUGIN) {
      await loadUniversalPlugin(this);
    }
    if ((order & LOAD_DEVKIT) === LOAD_DEVKIT) {
      await loadDevkits(this);
    }
  }

  loadInternalPlugins() {
    ['@feflow/feflow-plugin-devtool'].map((name: string) => {
      try {
        this.logger.debug('Plugin loaded: %s', chalk.magenta(name));
        return require(name)(this);
      } catch (err) {
        this.logger.error(
          { err: err },
          'Plugin load failed: %s',
          chalk.magenta(name)
        );
      }
    });
  }

  async call(name: any, ctx: any) {
    const args = ctx.args;
    if (args.h || args.help) {
      // 先打印插件命令描述
      await this.showCommandOptionDescription(name, ctx);
    }
    const cmd = this.commander.get(name);
    if (cmd) {
      this.logger.name = cmd.pluginName;
      await cmd.call(this, ctx);
    } else {
      this.logger.debug('Command `' + name + '` has not been registered yet!')
    }
  }

  async updateCli(packageManager: string) {
    return new Promise((resolve, reject) => {
      const args =
        packageManager === 'yarn'
          ? ['global', 'add', '@feflow/cli@latest', '--extract']
          : [
              'install',
              '@feflow/cli@latest',
              '--color=always',
              '--save',
              '--save-exact',
              '--loglevel',
              'error',
              '-g'
            ];

      const child = spawn(packageManager, args, { stdio: 'inherit' });
      child.on('close', code => {
        if (code !== 0) {
          reject({
            command: `${packageManager} ${args.join(' ')}`
          });
          return;
        }
        resolve();
      });
    });
  }

  async checkCliUpdate() {
    const { args, version, config, configPath } = this;
    if (!config) {
      return;
    }
    const packageManager = config.packageManager;
    const autoUpdate = args['auto-update'] || config.autoUpdate === 'true';
    if (
      config.lastUpdateCheck &&
      +new Date() - parseInt(config.lastUpdateCheck, 10) <= 1000 * 3600 * 24
    ) {
      return;
    }
    const registryUrl = await getRegistryUrl(packageManager);
    const latestVersion: any = await packageJson(
      '@feflow/cli',
      registryUrl
    ).catch(() => {
      this.logger.warn(
        `Network error, can't reach ${registryUrl}, CLI give up verison check.`
      );
    });

    this.logger.debug(`Auto update: ${autoUpdate}`);
    if (latestVersion && semver.gt(latestVersion, version)) {
      this.logger.debug(
        `Find new version, current version: ${version}, latest version: ${autoUpdate}`
      );
      if (autoUpdate) {
        this.logger.debug(
          `Auto update version from ${version} to ${latestVersion}`
        );
        return await this.updateCli(packageManager);
      }
      const askIfUpdateCli = [
        {
          type: 'confirm',
          name: 'ifUpdate',
          message: `${chalk.yellow(
            `@feflow/cli's latest version is ${chalk.green(
              `${latestVersion}`
            )}, but your version is ${chalk.red(
              `${version}`
            )}, Do you want to update it?`
          )}`,
          default: true
        }
      ];
      const answer = await inquirer.prompt(askIfUpdateCli);
      if (answer.ifUpdate) {
        await this.updateCli(packageManager);
      } else {
        safeDump(
          {
            ...config,
            lastUpdateCheck: +new Date()
          },
          configPath
        );
      }
    } else {
      this.logger.debug(`Current version is already latest.`);
    }
  }

  async showCommandOptionDescription(cmd: any, ctx: any): Promise<any> {
    const registriedCommand = ctx.commander.get(cmd);
    let commandLine: object[] = [];

    if (registriedCommand && registriedCommand.options) {
      commandLine = getCommandLine(
        registriedCommand.options,
        registriedCommand.desc,
        cmd
      );
    }

    if (cmd === 'help') {
      registriedCommand.call(this, ctx);
      return true;
    }
    if (commandLine.length == 0) {
      return false;
    }

    let sections = [];

    sections.push(...commandLine);
    const usage = commandLineUsage(sections);

    console.log(usage);
    return true;
  }
}
