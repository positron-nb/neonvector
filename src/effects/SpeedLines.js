// Full-screen canvas overlay that draws radial speed streaks, intensity driven
// by current speed ratio and nitro state. Cheap 2D canvas draw — kept
// separate from the WebGL scene so it never competes for GPU shader budget.
export class SpeedLines {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.style.position = 'fixed';
    this.canvas.style.inset = '0';
    this.canvas.style.zIndex = '5';
    this.canvas.style.pointerEvents = 'none';
    this.canvas.style.mixBlendMode = 'screen';
    document.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.resize();
    window.addEventListener('resize', () => this.resize());

    this.lines = [];
    const count = 60;
    for (let i = 0; i < count; i++) {
      this.lines.push({ angle: Math.random() * Math.PI * 2, dist: Math.random(), speed: 0.4 + Math.random() * 0.8, len: 0.05 + Math.random() * 0.12 });
    }
  }

  resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
    this.cx = this.canvas.width / 2;
    this.cy = this.canvas.height / 2;
    this.maxR = Math.hypot(this.cx, this.cy);
  }

  update(dt, intensity) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (intensity <= 0.02) return;

    ctx.strokeStyle = `rgba(160,230,255,${0.35 * intensity})`;
    ctx.lineWidth = 1.5;

    for (const line of this.lines) {
      line.dist += dt * line.speed * (0.6 + intensity * 2.2);
      if (line.dist > 1) {
        line.dist = 0;
        line.angle = Math.random() * Math.PI * 2;
      }
      const r0 = line.dist * this.maxR;
      const r1 = Math.min(this.maxR, r0 + line.len * this.maxR * (0.5 + intensity));
      const x0 = this.cx + Math.cos(line.angle) * r0;
      const y0 = this.cy + Math.sin(line.angle) * r0;
      const x1 = this.cx + Math.cos(line.angle) * r1;
      const y1 = this.cy + Math.sin(line.angle) * r1;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
  }

  setVisible(visible) {
    this.canvas.style.display = visible ? 'block' : 'none';
  }
}
