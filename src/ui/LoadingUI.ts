/** Loading overlay with progress bar; also the error toast. */
export class LoadingUI {
  private readonly root = document.getElementById('loading')!;
  private readonly label = document.getElementById('loading-label')!;
  private readonly bar = document.getElementById('loading-bar')!;
  private readonly toast = document.getElementById('toast')!;

  setProgress(fraction: number, text: string): void {
    this.label.textContent = text;
    this.bar.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
  }

  hide(): void {
    this.root.classList.add('done');
    setTimeout(() => this.root.remove(), 450);
  }

  showError(message: string): void {
    this.toast.textContent = `⚠ ${message}`;
    this.toast.classList.remove('hidden');
    this.toast.classList.add('error');
    setTimeout(() => this.toast.classList.add('hidden'), 8000);
  }
}
