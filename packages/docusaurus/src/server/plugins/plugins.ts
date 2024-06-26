/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {initPlugins} from './init';
import {createBootstrapPlugin, createMDXFallbackPlugin} from './synthetic';
import {localizePluginTranslationFile} from '../translations/translations';
import {sortRoutes} from './routeConfig';
import {PerfLogger} from '../../utils';
import {createPluginActionsUtils} from './actions';
import {
  aggregateAllContent,
  aggregateGlobalData,
  aggregateRoutes,
  getPluginByIdentifier,
  mergeGlobalData,
} from './pluginsUtils';
import type {
  LoadContext,
  RouteConfig,
  AllContent,
  GlobalData,
  PluginIdentifier,
  LoadedPlugin,
  InitializedPlugin,
} from '@docusaurus/types';

async function translatePluginContent({
  plugin,
  content,
  context,
}: {
  plugin: InitializedPlugin;
  content: unknown;
  context: LoadContext;
}): Promise<unknown> {
  const rawTranslationFiles =
    (await plugin.getTranslationFiles?.({content})) ?? [];

  const translationFiles = await Promise.all(
    rawTranslationFiles.map((translationFile) =>
      localizePluginTranslationFile({
        localizationDir: context.localizationDir,
        translationFile,
        plugin,
      }),
    ),
  );

  const translatedContent =
    plugin.translateContent?.({content, translationFiles}) ?? content;

  const translatedThemeConfigSlice = plugin.translateThemeConfig?.({
    themeConfig: context.siteConfig.themeConfig,
    translationFiles,
  });

  // TODO dangerous legacy, need to be refactored!
  // Side-effect to merge theme config translations. A plugin should only
  // translate its own slice of theme config and should make no assumptions
  // about other plugins' keys, so this is safe to run in parallel.
  Object.assign(context.siteConfig.themeConfig, translatedThemeConfigSlice);
  return translatedContent;
}

async function executePluginContentLoading({
  plugin,
  context,
}: {
  plugin: InitializedPlugin;
  context: LoadContext;
}): Promise<LoadedPlugin> {
  return PerfLogger.async(
    `Plugins - single plugin content loading - ${plugin.name}@${plugin.options.id}`,
    async () => {
      let content = await plugin.loadContent?.();

      content = await translatePluginContent({
        plugin,
        content,
        context,
      });

      if (!plugin.contentLoaded) {
        return {
          ...plugin,
          content,
          routes: [],
          globalData: undefined,
        };
      }

      const pluginActionsUtils = await createPluginActionsUtils({
        plugin,
        generatedFilesDir: context.generatedFilesDir,
        baseUrl: context.siteConfig.baseUrl,
        trailingSlash: context.siteConfig.trailingSlash,
      });

      await plugin.contentLoaded({
        content,
        actions: pluginActionsUtils.getActions(),
      });

      return {
        ...plugin,
        content,
        routes: pluginActionsUtils.getRoutes(),
        globalData: pluginActionsUtils.getGlobalData(),
      };
    },
  );
}

async function executeAllPluginsContentLoading({
  plugins,
  context,
}: {
  plugins: InitializedPlugin[];
  context: LoadContext;
}): Promise<LoadedPlugin[]> {
  return PerfLogger.async(`Plugins - all plugins content loading`, () => {
    return Promise.all(
      plugins.map((plugin) => executePluginContentLoading({plugin, context})),
    );
  });
}

async function executePluginAllContentLoaded({
  plugin,
  context,
  allContent,
}: {
  plugin: LoadedPlugin;
  context: LoadContext;
  allContent: AllContent;
}): Promise<{routes: RouteConfig[]; globalData: unknown}> {
  return PerfLogger.async(
    `Plugins - allContentLoaded - ${plugin.name}@${plugin.options.id}`,
    async () => {
      if (!plugin.allContentLoaded) {
        return {routes: [], globalData: undefined};
      }
      const pluginActionsUtils = await createPluginActionsUtils({
        plugin,
        generatedFilesDir: context.generatedFilesDir,
        baseUrl: context.siteConfig.baseUrl,
        trailingSlash: context.siteConfig.trailingSlash,
      });
      await plugin.allContentLoaded({
        allContent,
        actions: pluginActionsUtils.getActions(),
      });
      return {
        routes: pluginActionsUtils.getRoutes(),
        globalData: pluginActionsUtils.getGlobalData(),
      };
    },
  );
}

type AllContentLoadedResult = {routes: RouteConfig[]; globalData: GlobalData};

async function executeAllPluginsAllContentLoaded({
  plugins,
  context,
}: {
  plugins: LoadedPlugin[];
  context: LoadContext;
}): Promise<AllContentLoadedResult> {
  return PerfLogger.async(`Plugins - allContentLoaded`, async () => {
    const allContent = aggregateAllContent(plugins);

    const routes: RouteConfig[] = [];
    const globalData: GlobalData = {};

    await Promise.all(
      plugins.map(async (plugin) => {
        const {routes: pluginRoutes, globalData: pluginGlobalData} =
          await executePluginAllContentLoaded({
            plugin,
            context,
            allContent,
          });

        routes.push(...pluginRoutes);

        if (pluginGlobalData !== undefined) {
          globalData[plugin.name] ??= {};
          globalData[plugin.name]![plugin.options.id] = pluginGlobalData;
        }
      }),
    );

    return {routes, globalData};
  });
}

function mergeResults({
  plugins,
  allContentLoadedResult,
}: {
  plugins: LoadedPlugin[];
  allContentLoadedResult: AllContentLoadedResult;
}) {
  const routes: RouteConfig[] = [
    ...aggregateRoutes(plugins),
    ...allContentLoadedResult.routes,
  ];
  sortRoutes(routes);

  const globalData: GlobalData = mergeGlobalData(
    aggregateGlobalData(plugins),
    allContentLoadedResult.globalData,
  );

  return {routes, globalData};
}

export type LoadPluginsResult = {
  plugins: LoadedPlugin[];
  routes: RouteConfig[];
  globalData: GlobalData;
};

/**
 * Initializes the plugins and run their lifecycle functions.
 */
export async function loadPlugins(
  context: LoadContext,
): Promise<LoadPluginsResult> {
  return PerfLogger.async('Plugins - loadPlugins', async () => {
    const initializedPlugins: InitializedPlugin[] = await PerfLogger.async(
      'Plugins - initPlugins',
      () => initPlugins(context),
    );

    // TODO probably not the ideal place to hardcode those plugins
    initializedPlugins.push(
      createBootstrapPlugin(context),
      createMDXFallbackPlugin(context),
    );

    const plugins = await executeAllPluginsContentLoading({
      plugins: initializedPlugins,
      context,
    });

    const allContentLoadedResult = await executeAllPluginsAllContentLoaded({
      plugins,
      context,
    });

    const {routes, globalData} = mergeResults({
      plugins,
      allContentLoadedResult,
    });

    return {plugins, routes, globalData};
  });
}

export async function reloadPlugin({
  pluginIdentifier,
  plugins: previousPlugins,
  context,
}: {
  pluginIdentifier: PluginIdentifier;
  plugins: LoadedPlugin[];
  context: LoadContext;
}): Promise<LoadPluginsResult> {
  return PerfLogger.async('Plugins - reloadPlugin', async () => {
    const previousPlugin = getPluginByIdentifier({
      plugins: previousPlugins,
      pluginIdentifier,
    });
    const plugin = await executePluginContentLoading({
      plugin: previousPlugin,
      context,
    });

    /*
    // TODO Docusaurus v4 - upgrade to Node 20, use array.with()
    const plugins = previousPlugins.with(
      previousPlugins.indexOf(previousPlugin),
      plugin,
    );
     */
    const plugins = [...previousPlugins];
    plugins[previousPlugins.indexOf(previousPlugin)] = plugin;

    const allContentLoadedResult = await executeAllPluginsAllContentLoaded({
      plugins,
      context,
    });

    const {routes, globalData} = mergeResults({
      plugins,
      allContentLoadedResult,
    });

    return {plugins, routes, globalData};
  });
}
