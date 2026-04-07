(function () {
  'use strict';

  const PLUGIN_ID = 'auto-vision-tagging';
  const PLUGIN_LABEL = 'Auto Vision Tagging';
  const LOG_PREFIX_TAG_RESULT = `[Plugin / ${PLUGIN_LABEL}] tagResult=`;

  const csLib = window.csLib;
  const { getPluginConfig, runPluginTask, getJobStatus, getScene } = window.stashFunctions;

  const api = window.PluginApi;
  const React = api.React;
  const { Button } = api.libraries.Bootstrap;

  // Magic wand / tag icon
  const tagIconSvg = `
<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="7" cy="7" r="1.5" fill="currentColor"/>
</svg>`;

  let config = {
    autoTaggedTagId: '',
    batchTagId: '',
  };

  const activeJobs = new Map();

  const toastTemplate = {
    success: `<div class="toast fade show success" role="alert"><div class="d-flex"><div class="toast-body flex-grow-1">`,
    error: `<div class="toast fade show danger" role="alert"><div class="d-flex"><div class="toast-body flex-grow-1">`,
    bottom: `</div><button type="button" class="close ml-2 mb-1 mr-2" data-dismiss="toast" aria-label="Close"><span aria-hidden="true">&times;</span></button></div></div>`,
  };

  async function loadConfig() {
    try {
      const pluginConfig = await getPluginConfig(PLUGIN_ID);
      config.autoTaggedTagId = pluginConfig?.autoTaggedTagId || '';
      config.batchTagId = pluginConfig?.batchTagId || '';
    } catch (e) {
      console.warn('[AutoVisionTagging] Failed to load plugin config:', e);
    }
  }

  function showToast(message, type = 'success') {
    const template = type === 'error' ? toastTemplate.error : toastTemplate.success;
    const $toast = $(template + message + toastTemplate.bottom);
    const rmToast = () => {
      const hasSiblings = $toast.siblings().length > 0;
      $toast.remove();
      if (!hasSiblings) {
        $('.toast-container').addClass('hidden');
      }
    };
    $toast.find('button.close').click(rmToast);
    $('.toast-container').append($toast).removeClass('hidden');
    setTimeout(rmToast, 5000);
  }

  function getSceneIdFromUrl() {
    const match = window.location.pathname.match(/\/scenes\/(\d+)/);
    return match ? match[1] : null;
  }

  /**
   * Waits for a Stash job to finish.
   * @param {string} jobId
   * @param {function} onProgress
   * @returns {Promise<boolean>}
   */
  async function awaitJobFinished(jobId, onProgress) {
    return new Promise((resolve, reject) => {
      const interval = setInterval(async () => {
        try {
          const result = await getJobStatus(jobId);
          const status = result.findJob?.status;
          const progress = result.findJob?.progress;

          if (typeof progress === 'number' && progress >= 0 && onProgress) {
            onProgress(progress);
          }

          if (status === 'FINISHED') {
            clearInterval(interval);
            resolve(true);
          } else if (status === 'FAILED' || status === 'CANCELLED') {
            clearInterval(interval);
            reject(new Error(`Job ${status.toLowerCase()}`));
          }
        } catch (e) {
          console.warn('[AutoVisionTagging] getJobStatus failed:', e);
        }
      }, 500);
    });
  }

  /**
   * Polls Stash logs for a message with the given prefix.
   */
  async function pollLogsForMessage(prefix, delay = 0) {
    const reqTime = Date.now() + delay;
    const reqData = {
      variables: {},
      query: `query Logs {
        logs {
          time
          level
          message
        }
      }`,
    };
    await new Promise((r) => setTimeout(r, 500));
    let retries = 0;
    while (true) {
      const pollDelay = 2 ** retries * 100;
      await new Promise((r) => setTimeout(r, pollDelay));
      retries++;

      const logs = await csLib.callGQL(reqData);
      for (const log of logs.logs) {
        const logTime = Date.parse(log.time);
        if (logTime > reqTime && log.message.startsWith(prefix)) {
          return log.message.replace(prefix, '').trim();
        }
      }

      if (retries >= 10) {
        throw new Error(`Poll logs failed for message: ${prefix}`);
      }
    }
  }

  function refreshPage() {
    try {
      window.__APOLLO_CLIENT__.reFetchObservableQueries();
    } catch (e) {
      console.warn('[AutoVisionTagging] Apollo refresh failed, reloading page');
      window.location.reload();
    }
  }

  function updateButtonProgress(sceneId, percent) {
    const button = document.querySelector(`[data-avt-scene="${sceneId}"]`);
    if (button) {
      button.title = `Classifying... ${percent}%`;
      button.style.opacity = '0.6';
      button.style.pointerEvents = 'none';
    }
  }

  function resetButton(sceneId) {
    const button = document.querySelector(`[data-avt-scene="${sceneId}"]`);
    if (button) {
      button.title = 'Auto-tag this scene';
      button.style.opacity = '1';
      button.style.pointerEvents = 'auto';
    }
  }

  async function handleTagClick(sceneId) {
    if (activeJobs.has(sceneId)) {
      showToast('An auto-vision tagging job is already running for this scene', 'error');
      return;
    }

    try {
      const scene = await getScene(sceneId);
      if (!scene || !scene.files || scene.files.length === 0) {
        showToast('Scene has no video files', 'error');
        return;
      }

      const videoPath = scene.files[0].path;
      const sceneTitle = scene.title || `Scene ${sceneId}`;
      activeJobs.set(sceneId, true);

      showToast(`Starting classification for: ${sceneTitle}`);

      const result = await runPluginTask(
        PLUGIN_ID,
        'Tag Scene',
        [
          { key: 'mode', value: { str: 'tag' } },
          { key: 'scene_id', value: { str: sceneId } },
          { key: 'video_path', value: { str: videoPath } },
        ]
      );

      if (!result || !result.runPluginTask) {
        showToast('Failed to start classification task', 'error');
        activeJobs.delete(sceneId);
        resetButton(sceneId);
        return;
      }

      const jobId = result.runPluginTask;
      console.log(`[AutoVisionTagging] Job started: ${jobId}`);

      try {
        await awaitJobFinished(jobId, (progress) => {
          updateButtonProgress(sceneId, Math.round(progress * 100));
        });
      } catch (e) {
        showToast(`Classification failed: ${e.message}`, 'error');
        activeJobs.delete(sceneId);
        resetButton(sceneId);
        return;
      }

      try {
        const resultJson = await pollLogsForMessage(LOG_PREFIX_TAG_RESULT, -5000);
        const tagResult = JSON.parse(resultJson);
        if (tagResult.success) {
          const appliedCount = Array.isArray(tagResult.applied) ? tagResult.applied.length : 0;
          const skipped = tagResult.skipped || 0;
          showToast(`Applied ${appliedCount} tag(s) (policy=${tagResult.policy}, ${skipped} excluded)`);
          refreshPage();
        } else {
          showToast('Classification completed but reported no success', 'error');
        }
      } catch (e) {
        console.warn('[AutoVisionTagging] Failed to read tagResult from logs:', e);
        showToast('Classification complete. Refresh the page to see new tags.');
      }

      activeJobs.delete(sceneId);
      resetButton(sceneId);

    } catch (e) {
      console.error('[AutoVisionTagging] Error:', e);
      showToast(`Failed: ${e.message}`, 'error');
      activeJobs.delete(sceneId);
      resetButton(sceneId);
    }
  }

  const TagButton = ({ sceneId }) => {
    return React.createElement(Button, {
      className: 'minimal btn btn-secondary',
      id: 'avt-btn',
      title: 'Auto-tag this scene',
      'data-avt-scene': sceneId,
      onClick: () => handleTagClick(sceneId),
      dangerouslySetInnerHTML: { __html: tagIconSvg },
    });
  };

  async function injectButton() {
    const sceneId = getSceneIdFromUrl();
    if (!sceneId) return;

    if (document.querySelector(`[data-avt-scene="${sceneId}"]`)) {
      return;
    }

    try {
      const scene = await getScene(sceneId);
      if (!scene) return;

      const toolbar = document.querySelector('.scene-toolbar .btn-group');
      if (toolbar) {
        const container = document.createElement('span');
        container.className = 'avt-button';
        toolbar.appendChild(container);

        api.ReactDOM.render(
          React.createElement(TagButton, { sceneId }),
          container
        );
      }
    } catch (e) {
      console.error('[AutoVisionTagging] Error injecting button:', e);
    }
  }

  function cleanUI() {
    const existingButtons = document.querySelectorAll('.avt-button');
    existingButtons.forEach((button) => button.remove());
  }

  loadConfig();

  let debounceTimer = null;
  csLib.PathElementListener('/scenes/', '.scene-toolbar', function () {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      cleanUI();
      injectButton();
    }, 300);
  });
})();
