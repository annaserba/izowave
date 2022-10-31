import EventEmitter from 'events';

import { TutorialEvent, TutorialStep } from '~type/tutorial';

export class Tutorial extends EventEmitter {
  /**
   * Current step.
   */
  private _step: TutorialStep = IS_DEV_MODE
    ? TutorialStep.DONE
    : TutorialStep.BUILD_TOWER_FIRE;

  public get step() { return this._step; }

  private set step(v) { this._step = v; }

  /**
   *
   */
  public progress(step: TutorialStep) {
    this.step = step;

    this.emit(TutorialEvent.PROGRESS, step);
  }

  /**
   *
   */
  public complete() {
    this.progress(TutorialStep.DONE);
  }
}