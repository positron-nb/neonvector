export class CalibrationScreen {
  constructor() {
    this.overlay = document.getElementById('calibration-overlay');
    this.progressFill = document.getElementById('calib-progress');
  }

  show() { this.overlay.classList.remove('hidden'); }
  hide() { this.overlay.classList.add('hidden'); }

  setProgress(ratio) {
    this.progressFill.style.width = `${Math.round(ratio * 100)}%`;
  }
}
