/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import fs from 'fs-extra';
import _ from 'lodash';
import {prepareUrls} from 'react-dev-utils/WebpackDevServerUtils';
import {normalizeUrl} from '@docusaurus/utils';
import logger from '@docusaurus/logger';
import {getHostPort} from '../../server/getHostPort';
import {PerfLogger} from '../../utils';
import {
  loadSite,
  type LoadSiteParams,
  reloadSite,
  reloadSitePlugin,
} from '../../server/site';
import type {StartCLIOptions} from './start';
import type {LoadedPlugin} from '@docusaurus/types';

export type OpenUrlContext = {
  host: string;
  port: number;
  getOpenUrl: ({baseUrl}: {baseUrl: string}) => string;
};

export async function createOpenUrlContext({
  cliOptions,
}: {
  cliOptions: StartCLIOptions;
}): Promise<OpenUrlContext> {
  const protocol: string = process.env.HTTPS === 'true' ? 'https' : 'http';

  const {host, port} = await getHostPort(cliOptions);
  if (port === null) {
    return process.exit();
  }

  const getOpenUrl: OpenUrlContext['getOpenUrl'] = ({baseUrl}) => {
    const urls = prepareUrls(protocol, host, port);
    return normalizeUrl([urls.localUrlForBrowser, baseUrl]);
  };

  return {host, port, getOpenUrl};
}

type StartParams = {
  siteDirParam: string;
  cliOptions: Partial<StartCLIOptions>;
};

async function createLoadSiteParams({
  siteDirParam,
  cliOptions,
}: StartParams): Promise<LoadSiteParams> {
  const siteDir = await fs.realpath(siteDirParam);
  return {
    siteDir,
    config: cliOptions.config,
    locale: cliOptions.locale,
    localizePath: undefined, // Should this be configurable?
  };
}

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export async function createReloadableSite(startParams: StartParams) {
  const openUrlContext = await createOpenUrlContext(startParams);

  let site = await PerfLogger.async('Loading site', async () => {
    const params = await createLoadSiteParams(startParams);
    return loadSite(params);
  });

  const get = () => site;

  const getOpenUrl = () =>
    openUrlContext.getOpenUrl({
      baseUrl: site.props.baseUrl,
    });

  const printOpenUrlMessage = () => {
    logger.success`Docusaurus website is running at: url=${getOpenUrl()}`;
  };
  printOpenUrlMessage();

  const reloadBase = async () => {
    try {
      const oldSite = site;
      site = await PerfLogger.async('Reloading site', () => reloadSite(site));
      if (oldSite.props.baseUrl !== site.props.baseUrl) {
        printOpenUrlMessage();
      }
    } catch (e) {
      logger.error('Site reload failure');
      console.error(e);
    }
  };

  // TODO instead of debouncing we should rather add AbortController support?
  const reload = _.debounce(reloadBase, 500);

  // TODO this could be subject to plugin reloads race conditions
  //  In practice, it is not likely the user will hot reload 2 plugins at once
  //  but we should still support it and probably use a task queuing system
  const reloadPlugin = async (plugin: LoadedPlugin) => {
    try {
      site = await PerfLogger.async(
        `Reloading site plugin ${plugin.name}@${plugin.options.id}`,
        () => {
          const pluginIdentifier = {name: plugin.name, id: plugin.options.id};
          return reloadSitePlugin(site, pluginIdentifier);
        },
      );
    } catch (e) {
      logger.error(
        `Site plugin reload failure - Plugin ${plugin.name}@${plugin.options.id}`,
      );
      console.error(e);
    }
  };

  return {get, getOpenUrl, reload, reloadPlugin, openUrlContext};
}
