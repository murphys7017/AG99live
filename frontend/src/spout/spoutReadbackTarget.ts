interface Surface {
  framebuffer: WebGLFramebuffer;
  color: WebGLRenderbuffer;
  width: number;
  height: number;
}

// Keep premultiplied RGBA on the GPU until the requested output size is ready.
export class SpoutReadbackTarget {
  private resolved?: Surface;
  private scaled?: Surface;

  read(gl: WebGL2RenderingContext, width: number, height: number): void {
    const sourceWidth = gl.drawingBufferWidth;
    const sourceHeight = gl.drawingBufferHeight;
    const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    try {
      if (width !== sourceWidth || height !== sourceHeight) {
        const draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
        const renderbuffer = gl.getParameter(gl.RENDERBUFFER_BINDING);
        const scissor = gl.isEnabled(gl.SCISSOR_TEST);
        try {
          if (scissor) gl.disable(gl.SCISSOR_TEST);
          // A multisampled default framebuffer must resolve at its native size first.
          this.resolved = this.surface(gl, this.resolved, sourceWidth, sourceHeight);
          this.scaled = this.surface(gl, this.scaled, width, height);
          gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.resolved.framebuffer);
          gl.blitFramebuffer(0, 0, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight, gl.COLOR_BUFFER_BIT, gl.NEAREST);
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.resolved.framebuffer);
          gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.scaled.framebuffer);
          gl.blitFramebuffer(0, 0, sourceWidth, sourceHeight, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.LINEAR);
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.scaled.framebuffer);
        } finally {
          gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw);
          gl.bindRenderbuffer(gl.RENDERBUFFER, renderbuffer);
          if (scissor) gl.enable(gl.SCISSOR_TEST);
        }
      } else if (this.scaled) {
        this.release(gl);
      }
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    } finally {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
    }
  }

  private surface(gl: WebGL2RenderingContext, existing: Surface | undefined, width: number, height: number): Surface {
    if (existing?.width === width && existing.height === height) return existing;
    const framebuffer = existing?.framebuffer ?? gl.createFramebuffer();
    const color = existing?.color ?? gl.createRenderbuffer();
    if (!color || !framebuffer) {
      if (!existing) { gl.deleteRenderbuffer(color); gl.deleteFramebuffer(framebuffer); }
      throw new Error("spout_surface_allocation_failed");
    }
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, framebuffer);
    gl.bindRenderbuffer(gl.RENDERBUFFER, color);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, width, height);
    gl.framebufferRenderbuffer(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
    if (gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      if (!existing) { gl.deleteRenderbuffer(color); gl.deleteFramebuffer(framebuffer); }
      throw new Error("spout_framebuffer_incomplete");
    }
    return { framebuffer, color, width, height };
  }

  release(gl: WebGL2RenderingContext): void {
    for (const surface of [this.resolved, this.scaled]) {
      if (!surface) continue;
      gl.deleteRenderbuffer(surface.color);
      gl.deleteFramebuffer(surface.framebuffer);
    }
    this.resolved = this.scaled = undefined;
  }
}
