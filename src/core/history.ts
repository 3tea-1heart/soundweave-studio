import type { Project } from './types';
import { cloneProject } from './project';

/** 快照式撤销/重做（工程规模小，快照简单可靠） */
export class History {
  private stack: Project[] = [];
  private index = -1;
  private limit = 60;

  reset(project: Project): void {
    this.stack = [cloneProject(project)];
    this.index = 0;
  }

  push(project: Project): void {
    const snap = cloneProject(project);
    if (this.index >= 0 && JSON.stringify(this.stack[this.index]) === JSON.stringify(snap)) return;
    this.stack = this.stack.slice(0, this.index + 1);
    this.stack.push(snap);
    if (this.stack.length > this.limit) {
      this.stack.shift();
    } else {
      this.index++;
    }
    if (this.index >= this.stack.length) this.index = this.stack.length - 1;
  }

  undo(): Project | null {
    if (this.index <= 0) return null;
    this.index--;
    return cloneProject(this.stack[this.index]);
  }

  redo(): Project | null {
    if (this.index >= this.stack.length - 1) return null;
    this.index++;
    return cloneProject(this.stack[this.index]);
  }

  get canUndo(): boolean {
    return this.index > 0;
  }

  get canRedo(): boolean {
    return this.index < this.stack.length - 1;
  }
}
