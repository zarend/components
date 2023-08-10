/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {BooleanInput, coerceBooleanProperty} from '@angular/cdk/coercion';
import {ChangeDetectorRef, Directive, Input, inject} from '@angular/core';

import {CdkTree, CdkTreeNode} from './tree';

/**
 * Node toggle to expand/collapse the node.
 */
@Directive({
  selector: '[cdkTreeNodeToggle]',
  host: {
    '(click)': '_toggle($event)',
    'tabindex': '-1',
  },
})
export class CdkTreeNodeToggle<T, K = T> {
  /** Whether expand/collapse the node recursively. */
  @Input('cdkTreeNodeToggleRecursive')
  get recursive(): boolean {
    return this._recursive;
  }
  set recursive(value: BooleanInput) {
    this._recursive = coerceBooleanProperty(value);
  }
  protected _recursive = false;

  constructor(protected _tree: CdkTree<T, K>, protected _treeNode: CdkTreeNode<T, K>) {}

  // Toggle the expanded or collapsed state of this node.

  // Focus this node with expanding or collapsing it. This ensures that the active node will always
  // be visible when expanding and collapsing.
  _toggle(event: Event): void {
    this.recursive
      ? this._tree.toggleDescendants(this._treeNode.data)
      : this._tree.toggle(this._treeNode.data);

    this._tree._keyManager.setActiveItem(this._treeNode);

    event.stopPropagation();
  }
}
