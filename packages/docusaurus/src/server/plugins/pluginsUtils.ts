/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import _ from 'lodash';
import logger from '@docusaurus/logger';
import type {
  AllContent,
  GlobalData,
  InitializedPlugin,
  LoadedPlugin,
  PluginIdentifier,
  RouteConfig,
} from '@docusaurus/types';

export function getPluginByIdentifier<P extends InitializedPlugin>({
  plugins,
  pluginIdentifier,
}: {
  pluginIdentifier: PluginIdentifier;
  plugins: P[];
}): P {
  const plugin = plugins.find(
    (p) =>
      p.name === pluginIdentifier.name && p.options.id === pluginIdentifier.id,
  );
  if (!plugin) {
    throw new Error(
      logger.interpolate`Plugin not found for identifier ${pluginIdentifier.name}@${pluginIdentifier.id}`,
    );
  }
  return plugin;
}

export function aggregateAllContent(loadedPlugins: LoadedPlugin[]): AllContent {
  return _.chain(loadedPlugins)
    .groupBy((item) => item.name)
    .mapValues((nameItems) =>
      _.chain(nameItems)
        .groupBy((item) => item.options.id)
        .mapValues((idItems) => idItems[0]!.content)
        .value(),
    )
    .value();
}

export function aggregateRoutes(loadedPlugins: LoadedPlugin[]): RouteConfig[] {
  return loadedPlugins.flatMap((p) => p.routes);
}

export function aggregateGlobalData(loadedPlugins: LoadedPlugin[]): GlobalData {
  const globalData: GlobalData = {};
  loadedPlugins.forEach((plugin) => {
    if (plugin.globalData !== undefined) {
      globalData[plugin.name] ??= {};
      globalData[plugin.name]![plugin.options.id] = plugin.globalData;
    }
  });

  return globalData;
}

export function mergeGlobalData(...globalDataList: GlobalData[]): GlobalData {
  const result: GlobalData = {};

  const allPluginIdentifiers: PluginIdentifier[] = globalDataList.flatMap(
    (gd) =>
      Object.keys(gd).flatMap((name) =>
        Object.keys(gd[name]!).map((id) => ({name, id})),
      ),
  );

  allPluginIdentifiers.forEach(({name, id}) => {
    const allData = globalDataList
      .map((gd) => gd?.[name]?.[id])
      .filter((d) => typeof d !== 'undefined');
    const mergedData =
      allData.length === 1 ? allData[0] : Object.assign({}, ...allData);
    result[name] ??= {};
    result[name]![id] = mergedData;
  });

  return result;
}
