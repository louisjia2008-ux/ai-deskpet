/** Reserve before awaiting worker shutdown: recording and a new output must
 * never win the same race. Old cleanup cannot release a newer reservation. */
export class SpeechTurnGate {
  #owner: symbol | null = null;
  get busy(): boolean { return this.#owner !== null; }
  reserve(): symbol | null {
    if (this.#owner) return null;
    return this.#owner = Symbol('speech-turn');
  }
  current(token: symbol): boolean { return this.#owner === token; }
  release(token: symbol): void { if (this.current(token)) this.#owner = null; }
}
