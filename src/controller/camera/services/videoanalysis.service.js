'use-strict';

const _ = require('lodash');
const P2P = require('pipe2pam');
const PamDiff = require('pam-diff');
const { spawn } = require('child_process');

const cameraUtils = require('../utils/camera.utils');
const { Ping } = require('../../../common/ping');

const { Database } = require('../../../api/database');

const { LoggerService } = require('../../../services/logger/logger.service');
const { ConfigService } = require('../../../services/config/config.service');

const { MotionController } = require('../../motion/motion.controller');

const { log } = LoggerService;

const isUINT = (value) => Number.isInteger(value) && value >= 0;

const FFMPEG_MODE = 'rgba'; // gray, rgba, rgb24
const FFMPEG_RESOLUTION = '640:360';
const FFMPEG_FPS = '2';
const DIFFERENCE = 9;
const GRAYSCALE = 'luminosity';

class VideoAnalysisService {
  #camera;
  #socket;
  #prebufferService;

  videoanalysisSession = null;
  killed = false;
  cameraState = true;
  restartTimer = null;
  watchdog = null;

  motionTriggered = false;

  constructor(camera, prebufferService, socket) {
    //log.debug('Initializing video analysis', camera.name);

    this.#camera = camera;
    this.#socket = socket;
    this.#prebufferService = prebufferService;

    this.cameraName = camera.name;
  }

  reconfigure(camera) {
    const oldVideoConfig = this.#camera.videoConfig;
    const newVideoConfig = camera.videoConfig;

    this.#camera = camera;
    this.cameraName = camera.name;

    if (!_.isEqual(oldVideoConfig, newVideoConfig) && this.videoanalysisSession) {
      log.info('Videoanalysis: Video configuration changed! Restarting...', this.cameraName);

      this.restart();
    }
  }

  changeSensitivity(sensitivity) {
    if (sensitivity >= 0 && sensitivity <= 100 && this.videoanalysisSession?.pamDiff) {
      this.videoanalysisSession.pamDiff.setDifference(DIFFERENCE);
      this.videoanalysisSession.pamDiff.setPercent(100 - sensitivity);
    }
  }

  changeZone(regions = [], sensitivity) {
    if (this.videoanalysisSession?.pamDiff) {
      this.videoanalysisSession.pamDiff.resetCache();
      this.changeSensitivity(sensitivity);
      const zones = this.#createRegions(regions, sensitivity);
      this.videoanalysisSession.pamDiff.setRegions(zones.length > 0 ? zones : null);
    }
  }

  async start() {
    try {
      this.resetVideoAnalysis();

      this.cameraState = await this.#pingCamera();

      if (!this.cameraState) {
        log.warn(
          'Can not start video analysis, camera not reachable. Trying again in 60s..',
          this.cameraName,
          'videoanalysis'
        );

        this.stop(true);
        setTimeout(() => this.start(), 60000);

        return;
      }

      this.videoanalysisSession = await this.#startVideoAnalysis();

      const midnight = this.#millisUntilMidnight();
      const timer = midnight + 3 * 60 * 60 * 1000;

      log.info(`Videoanalysis scheduled for restart at 3AM: ${Math.round(timer / 1000 / 60)} minutes`, this.cameraName);

      this.restartTimer = setTimeout(() => {
        log.info('Sheduled restart of videoanalysis is executed...', this.cameraName);
        this.restart();
      }, timer);
    } catch (error) {
      if (error) {
        log.info('An error occured during starting videoanalysis!', this.cameraName, 'videoanalysis');
        log.error(error, this.cameraName, 'videoanalysis');
      }
    }
  }

  resetVideoAnalysis() {
    this.stop(true);

    this.videoanalysisSession = null;
    this.killed = false;
    this.cameraState = true;
    this.restartTimer = null;
    this.watchdog = null;
    this.motionTriggered = false;
  }

  stop(killed) {
    if (this.videoanalysisSession) {
      if (killed) {
        this.killed = true;
      }

      if (this.watchdog) {
        clearTimeout(this.watchdog);
      }

      if (this.restartTimer) {
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
      }

      this.videoanalysisSession.cp?.kill('SIGKILL');
      this.videoanalysisSession = undefined;
    }
  }

  restart() {
    log.info('Restart videoanalysis session..', this.cameraName);
    this.stop(true);
    setTimeout(() => this.start(), 10000);
  }

  async #startVideoAnalysis() {
    if (this.videoanalysisSession) {
      return this.videoanalysisSession;
    }

    let isActive = true;

    log.debug('Start videoanalysis...', this.cameraName);

    const videoConfig = cameraUtils.generateVideoConfig(this.#camera.videoConfig);
    let input = cameraUtils.generateInputSource(videoConfig, videoConfig.subSource).split(/\s+/);
    let prebufferInput = false;
    let invalidSubstream = videoConfig.subSource === videoConfig.source;

    if (this.#camera.prebuffering && invalidSubstream) {
      try {
        input = prebufferInput = await this.#prebufferService.getVideo();
      } catch {
        // ignore
      }
    }

    if (!prebufferInput && videoConfig.mapvideo) {
      input.push('-map', videoConfig.mapvideo);
    }

    const ffmpegArguments = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-hwaccel',
      'auto',
      ...input,
      '-an',
      '-vcodec',
      'pam',
      '-pix_fmt',
      FFMPEG_MODE,
      '-f',
      'image2pipe',
      '-vf',
      `fps=${FFMPEG_FPS},scale=${FFMPEG_RESOLUTION}`,
      'pipe:1',
    ];

    log.debug(
      `Videoanalysis command: ${ConfigService.ui.options.videoProcessor} ${ffmpegArguments.join(' ')}`,
      this.cameraName
    );

    const settings = await Database.interfaceDB.get('settings').get('cameras').find({ name: this.cameraName }).value();

    const errors = [];
    const regions = this.#createRegions(settings?.videoanalysis?.regions, settings?.videoanalysis?.sensitivity);

    const p2p = new P2P();
    const pamDiff = new PamDiff({
      //difference: settings?.videoanalysis?.difference || 9,
      grayscale: GRAYSCALE,
      difference: DIFFERENCE,
      percent: settings?.videoanalysis?.percentage || 5,
      regions: regions.length > 0 ? regions : null,
      //response: 'percent',
      response: 'bounds',
      draw: true,
    });

    const restartWatchdog = () => {
      clearTimeout(this.watchdog);
      this.watchdog = setTimeout(() => {
        log.error('Watchdog for videoanalysis timed out... killing ffmpeg session', this.cameraName, 'videoanalysis');
        cp?.kill('SIGKILL');

        isActive = false;
      }, 15000);
    };

    p2p.on('pam', () => {
      restartWatchdog();

      this.#socket.emit('videoanalysisStatus', {
        camera: this.cameraName,
        status: 'active',
      });

      isActive = true;
    });

    // eslint-disable-next-line no-unused-vars
    pamDiff.on('diff', async (data) => {
      if (!this.motionTriggered) {
        this.motionTriggered = true;

        log.debug(`Motion detected via Videoanalysis: ${JSON.stringify(data.trigger)}`, this.cameraName);

        const result = await MotionController.handleMotion('motion', this.cameraName, true, 'videoanalysis', {});
        log.debug(`Received a new VIDEOANALYSIS message ${JSON.stringify(result)} (${this.cameraName})`);

        setTimeout(() => {
          this.motionTriggered = false;
        }, 60000);
      }
    });

    const cp = spawn(ConfigService.ui.options.videoProcessor, ffmpegArguments, {
      env: process.env,
    });

    cp.stderr.on('data', (data) => errors.push(data.toString().replace(/(\r\n|\n|\r)/gm, '')));

    cp.on('exit', (code, signal) => {
      isActive = false;

      if (code === 1) {
        errors.unshift(`FFmpeg videoanalysis process exited with error! (${signal})`);
        log.error(errors.join(' - '), this.cameraName, 'videoanalysis');
      } else {
        log.debug('FFmpeg videoanalysis process exited (expected)', this.cameraName);
      }
    });

    cp.on('close', () => {
      isActive = false;

      log.debug('Videoanalysis process closed', this.cameraName);

      this.#socket.emit('videoanalysisStatus', {
        camera: this.cameraName,
        status: 'inactive',
      });

      if (!this.killed) {
        this.restart();
      }
    });

    cp.stdout.pipe(p2p).pipe(pamDiff);

    restartWatchdog();

    return {
      isActive() {
        return isActive;
      },
      cp,
      pamDiff,
    };
  }

  #millisUntilMidnight() {
    const midnight = new Date();
    midnight.setHours(24);
    midnight.setMinutes(0);
    midnight.setSeconds(0);
    midnight.setMilliseconds(0);
    return midnight.getTime() - Date.now();
  }

  async #pingCamera() {
    let state = true;

    try {
      state = await Ping.status(this.#camera, 1);
    } catch (error) {
      log.info('An error occured during pinging camera, skipping..', this.cameraName);
      log.error(error, this.cameraName);
    }

    return state;
  }

  #createRegions(regions = [], sensitivity) {
    sensitivity = sensitivity >= 0 && sensitivity <= 100 ? sensitivity : 50;

    const zones = regions
      ?.map((region, index) => {
        if (region.coords?.length > 2) {
          return {
            name: `region${index}`,
            difference: 9,
            percent: 100 - sensitivity,
            polygon: region.coords
              ?.map((coord) => {
                let x = coord[0] < 0 ? 0 : coord[0] > 100 ? 100 : coord[0];
                let y = coord[1] < 0 ? 0 : coord[1] > 100 ? 100 : coord[1];
                if (isUINT(x) && isUINT(y)) {
                  //x: 0 - 100 %   => 0 - 640 px
                  //y: 0 - 100 %   => 0 - 360 px
                  return {
                    x: Math.round((640 / 100) * x),
                    y: Math.round((360 / 100) * y),
                  };
                }
              })
              .filter((coord) => coord),
          };
        }
      })
      .filter((zone) => zone?.polygon?.length > 2);

    log.debug(`Videoanalysis: Currently active zones: ${JSON.stringify(zones)}`, this.cameraName);

    return zones;
  }
}

exports.VideoAnalysisService = VideoAnalysisService;
