(function () {
  'use strict';

  const csLib = window.csLib;

  /**
   * Retrieves plugin configuration from Stash settings.
   * @param {string} pluginId - The plugin ID.
   * @returns {Promise<object>} - Plugin configuration object (empty if none).
   */
  async function getPluginConfig(pluginId) {
    const reqData = {
      query: `query Configuration {
        configuration {
          plugins
        }
      }`,
    };
    const result = await csLib.callGQL(reqData);
    const plugins = result?.configuration?.plugins || {};
    return plugins[pluginId] || {};
  }

  /**
   * Runs a plugin task via GraphQL.
   * @param {string} pluginId - The plugin ID.
   * @param {string} taskName - The task name.
   * @param {Array} args - Array of {key, value} argument objects.
   * @returns {Promise<object>} - The mutation result with job ID.
   */
  async function runPluginTask(pluginId, taskName, args) {
    const reqData = {
      variables: {
        plugin_id: pluginId,
        task_name: taskName,
        args: args,
      },
      query: `mutation RunPluginTask($plugin_id: ID!, $task_name: String!, $args: [PluginArgInput!]) {
        runPluginTask(plugin_id: $plugin_id, task_name: $task_name, args: $args)
      }`,
    };
    return csLib.callGQL(reqData);
  }

  /**
   * Gets the status and progress of a Stash job.
   * @param {string} jobId - The job ID.
   * @returns {Promise<object>} - Job status wrapper.
   */
  async function getJobStatus(jobId) {
    const reqData = {
      variables: { id: jobId },
      query: `query ($id: ID!) {
        findJob(input: { id: $id }) {
          status
          progress
        }
      }`,
    };
    return csLib.callGQL(reqData);
  }

  /**
   * Gets a scene by ID.
   * @param {string} sceneId - The scene ID.
   * @returns {Promise<object>} - Scene object.
   */
  async function getScene(sceneId) {
    const reqData = {
      query: `{
        findScene(id: "${sceneId}") {
          id
          title
          files {
            path
          }
          tags {
            id
            name
          }
        }
      }`,
    };
    const result = await csLib.callGQL(reqData);
    return result?.findScene;
  }

  window.stashFunctions = {
    getPluginConfig,
    runPluginTask,
    getJobStatus,
    getScene,
  };
})();
