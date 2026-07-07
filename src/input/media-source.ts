import type { SourceKind } from "../state";

export interface MediaSourceHandle {
  element: HTMLVideoElement | HTMLImageElement;
  kind: SourceKind;
  isVideo: boolean;
}

export type StatusListener = (status: string) => void;

/**
 * Owns the live media element(s) and switches between webcam / fallback
 * sample assets. Webcam denial or absence falls back to car.mp4 without
 * blocking the rest of the UI (requirements §7/§9).
 */
export class MediaSourceManager {
  private webcamVideo: HTMLVideoElement;
  private carVideo: HTMLVideoElement;
  private dimsImage: HTMLImageElement;
  private stream: MediaStream | null = null;
  private current: SourceKind = "webcam";
  private onStatus: StatusListener;

  constructor(onStatus: StatusListener) {
    this.onStatus = onStatus;

    this.webcamVideo = document.createElement("video");
    this.webcamVideo.muted = true;
    this.webcamVideo.playsInline = true;

    this.carVideo = document.createElement("video");
    this.carVideo.src = "/car.mp4";
    this.carVideo.loop = true;
    this.carVideo.muted = true;
    this.carVideo.playsInline = true;

    this.dimsImage = new Image();
    this.dimsImage.src = "/dims.apnews.jpg";

    // Kept out of `display:none` deliberately — some browsers throttle
    // decode/rAF for display:none video, which would stall the texture feed.
    for (const v of [this.webcamVideo, this.carVideo]) {
      v.style.position = "fixed";
      v.style.left = "-9999px";
      v.style.top = "-9999px";
      v.style.width = "1px";
      v.style.height = "1px";
      document.body.appendChild(v);
    }
  }

  async init(): Promise<SourceKind> {
    return this.trySwitchTo("webcam");
  }

  getHandle(): MediaSourceHandle {
    if (this.current === "webcam") {
      return { element: this.webcamVideo, kind: "webcam", isVideo: true };
    }
    if (this.current === "car") {
      return { element: this.carVideo, kind: "car", isVideo: true };
    }
    return { element: this.dimsImage, kind: "dims", isVideo: false };
  }

  isReady(): boolean {
    const h = this.getHandle();
    if (h.isVideo) {
      const v = h.element as HTMLVideoElement;
      return v.readyState >= v.HAVE_CURRENT_DATA;
    }
    return (h.element as HTMLImageElement).complete;
  }

  async trySwitchTo(kind: SourceKind): Promise<SourceKind> {
    if (kind === "webcam") {
      try {
        this.onStatus("requesting webcam…");
        this.stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        this.webcamVideo.srcObject = this.stream;
        await this.webcamVideo.play();
        this.current = "webcam";
        this.onStatus("webcam live");
        return "webcam";
      } catch (err) {
        this.onStatus(`webcam unavailable (${(err as Error).message}) — falling back to car.mp4`);
        return this.trySwitchTo("car");
      }
    }

    this.stopWebcam();

    if (kind === "car") {
      this.current = "car";
      try {
        await this.carVideo.play();
      } catch {
        // Autoplay can be blocked until a user gesture; UI has a play affordance.
      }
      this.onStatus("sample video: car.mp4");
      return "car";
    }

    this.current = "dims";
    this.onStatus("sample image: dims.apnews.jpg");
    return "dims";
  }

  private stopWebcam() {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
  }

  resumeIfNeeded() {
    const h = this.getHandle();
    if (h.isVideo) {
      const v = h.element as HTMLVideoElement;
      if (v.paused) v.play().catch(() => {});
    }
  }
}
