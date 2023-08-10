/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {
  DOWN_ARROW,
  END,
  ENTER,
  HOME,
  LEFT_ARROW,
  RIGHT_ARROW,
  SPACE,
  TAB,
  UP_ARROW,
  A,
  Z,
  ZERO,
  NINE,
} from '@angular/cdk/keycodes';
import {QueryList} from '@angular/core';
import {of as observableOf, isObservable, Observable, Subject, Subscription} from 'rxjs';
import {debounceTime, filter, map, take, tap} from 'rxjs/operators';

const DEFAULT_TYPEAHEAD_DEBOUNCE_INTERVAL_MS = 200;

function coerceObservable<T>(data: T | Observable<T>): Observable<T> {
  if (!isObservable(data)) {
    return observableOf(data);
  }
  return data;
}

/** Represents an item within a tree that can be passed to a TreeKeyManager. */
export interface TreeKeyManagerItem {
  /** Whether the item is disabled. */
  isDisabled?: (() => boolean) | boolean;

  /** The user-facing label for this item. */
  getLabel?(): string;

  /** Perform the main action (i.e. selection) for this item. */
  activate(): void;

  /** Retrieves the parent for this item. This is `null` if there is no parent. */
  getParent(): TreeKeyManagerItem | null;

  /** Retrieves the children for this item. */
  getChildren(): TreeKeyManagerItem[] | Observable<TreeKeyManagerItem[]>;

  /** Determines if the item is currently expanded. */
  isExpanded: (() => boolean) | boolean;

  /** Collapses the item, hiding its children. */
  collapse(): void;

  /** Expands the item, showing its children. */
  expand(): void;

  /**
   * Focuses the item. This should provide some indication to the user that this item is focused.
   */
  focus(): void;
}

export interface TreeKeyManagerOptions<T extends TreeKeyManagerItem> {
  items: Observable<T[]> | QueryList<T> | T[];

  /**
   * Sets the predicate function that determines which items should be skipped by the tree key
   * manager. By default, disabled items are skipped.
   *
   * If the item is to be skipped, this function should return false.
   */
  skipPredicate?: (item: T) => boolean;

  /**
   * If true, then the key manager will call `activate` in addition to calling `focus` when a
   * particular item is focused. By default, this is false.
   */
  activationFollowsFocus?: boolean;

  /**
   * The direction in which the tree items are laid out horizontally. This influences which key
   * will be interpreted as expand or collapse. Defaults to 'ltr'.
   */
  horizontalOrientation?: 'rtl' | 'ltr';

  /**
   * If provided, determines how the key manager determines if two items are equivalent.
   *
   * It should provide a unique key for each unique tree item. If two tree items are equivalent,
   * then this function should return the same value.
   */
  trackBy?: (treeItem: T) => unknown;

  /**
   * If a value is provided, enables typeahead mode, which allows users to set the active item
   * by typing the visible label of the item.
   *
   * If a number is provided, this will be the time to wait after the last keystroke before
   * setting the active item. If `true` is provided, the default interval of 200ms will be used.
   */
  typeAheadDebounceInterval?: true | number;
}

/**
 * This class manages keyboard events for trees. If you pass it a QueryList or other list of tree
 * items, it will set the active item, focus, handle expansion and typeahead correctly when
 * keyboard events occur.
 */
export class TreeKeyManager<T extends TreeKeyManagerItem> {
  private _activeItemIndex = -1;
  private _activeItem: T | null = null;
  private _activationFollowsFocus = false;
  private _horizontal: 'ltr' | 'rtl' = 'ltr';
  private readonly _letterKeyStream = new Subject<string>();
  private _typeaheadSubscription = Subscription.EMPTY;

  /**
   * Predicate function that can be used to check whether an item should be skipped
   * by the key manager. By default, disabled items are skipped.
   */
  private _skipPredicateFn = (item: T) => this._isItemDisabled(item);

  /** Function to determine equivalent items. */
  private _trackByFn: (item: T) => unknown = (item: T) => item;

  /** Buffer for the letters that the user has pressed when the typeahead option is turned on. */
  private _pressedLetters: string[] = [];

  private _items: T[] = [];

  constructor({
    items,
    skipPredicate,
    trackBy,
    horizontalOrientation,
    activationFollowsFocus,
    typeAheadDebounceInterval,
  }: TreeKeyManagerOptions<T>) {
    // We allow for the items to be an array or Observable because, in some cases, the consumer may
    // not have access to a QueryList of the items they want to manage (e.g. when the
    // items aren't being collected via `ViewChildren` or `ContentChildren`).
    if (items instanceof QueryList) {
      this._items = items.toArray();
      items.changes.subscribe((newItems: QueryList<T>) => {
        this._items = newItems.toArray();
        this._updateActiveItemIndex(this._items);
      });
    } else if (isObservable(items)) {
      items.subscribe(newItems => {
        this._items = newItems;
        this._updateActiveItemIndex(newItems);
      });
    } else {
      this._items = items;
    }

    if (typeof skipPredicate !== 'undefined') {
      this._skipPredicateFn = skipPredicate;
    }
    if (typeof trackBy !== 'undefined') {
      this._trackByFn = trackBy;
    }
    if (typeof horizontalOrientation !== 'undefined') {
      this._horizontal = horizontalOrientation;
    }
    if (typeof activationFollowsFocus !== 'undefined') {
      this._activationFollowsFocus = activationFollowsFocus;
    }
    if (typeof typeAheadDebounceInterval !== 'undefined') {
      this._setTypeAhead(
        typeof typeAheadDebounceInterval === 'number'
          ? typeAheadDebounceInterval
          : DEFAULT_TYPEAHEAD_DEBOUNCE_INTERVAL_MS,
      );
    }
  }

  /**
   * Stream that emits any time the TAB key is pressed, so components can react
   * when focus is shifted off of the list.
   */
  readonly tabOut = new Subject<void>();

  /** Stream that emits any time the focused item changes. */
  readonly change = new Subject<T | null>();

  /**
   * Handles a keyboard event on the tree.
   * @param event Keyboard event that represents the user interaction with the tree.
   */
  onKeydown(event: KeyboardEvent) {
    const keyCode = event.keyCode;

    switch (keyCode) {
      case TAB:
        this.tabOut.next();
        // NB: return here, in order to allow Tab to actually tab out of the tree
        return;

      case DOWN_ARROW:
        this._focusNextItem();
        break;

      case UP_ARROW:
        this._focusPreviousItem();
        break;

      case RIGHT_ARROW:
        this._horizontal === 'rtl' ? this._collapseCurrentItem() : this._expandCurrentItem();
        break;

      case LEFT_ARROW:
        this._horizontal === 'rtl' ? this._expandCurrentItem() : this._collapseCurrentItem();
        break;

      case HOME:
        this._focusFirstItem();
        break;

      case END:
        this._focusLastItem();
        break;

      case ENTER:
      case SPACE:
        this._activateCurrentItem();
        break;

      default:
        // The keyCode for `*` is the same as the keyCode for `8`, so we check the event key
        // instead.
        if (event.key === '*') {
          this._expandAllItemsAtCurrentItemLevel();
          break;
        }

        // Attempt to use the `event.key` which also maps it to the user's keyboard language,
        // otherwise fall back to resolving alphanumeric characters via the keyCode.
        if (event.key && event.key.length === 1) {
          this._letterKeyStream.next(event.key.toLocaleUpperCase());
        } else if ((keyCode >= A && keyCode <= Z) || (keyCode >= ZERO && keyCode <= NINE)) {
          this._letterKeyStream.next(String.fromCharCode(keyCode));
        }

        // NB: return here, in order to avoid preventing the default action of non-navigational
        // keys or resetting the buffer of pressed letters.
        return;
    }

    // Reset the typeahead since the user has used a navigational key.
    this._pressedLetters = [];
    event.preventDefault();
  }

  /**
   * Handles a mouse click on a particular tree item.
   * @param treeItem The item that was clicked by the user.
   */
  onClick(treeItem: T) {
    this.setActiveItem(treeItem);
  }

  /** Index of the currently active item. */
  getActiveItemIndex(): number | null {
    return this._activeItemIndex;
  }

  /** The currently active item. */
  getActiveItem(): T | null {
    return this._activeItem;
  }

  /**
   * Focus the initial element; this is intended to be called when the tree is focused for
   * the first time.
   */
  onInitialFocus(): void {
    this._focusFirstItem();
  }

  setActiveItem(index: number): void;
  setActiveItem(item: T): void;
  setActiveItem(itemOrIndex: number | T) {
    let index =
      typeof itemOrIndex === 'number'
        ? itemOrIndex
        : this._items.findIndex(item => this._trackByFn(item) === this._trackByFn(itemOrIndex));
    if (index < 0 || index >= this._items.length) {
      return;
    }
    const activeItem = this._items[index];

    // If we're just setting the same item, don't re-call activate or focus
    if (
      this._activeItem !== null &&
      this._trackByFn(activeItem) === this._trackByFn(this._activeItem)
    ) {
      return;
    }

    this._activeItem = activeItem ?? null;
    this._activeItemIndex = index;

    this.change.next(this._activeItem);
    this._activeItem?.focus();
    if (this._activationFollowsFocus) {
      this._activateCurrentItem();
    }
  }

  private _updateActiveItemIndex(newItems: T[]) {
    if (this._activeItem) {
      const newIndex = newItems.indexOf(this._activeItem);

      if (newIndex > -1 && newIndex !== this._activeItemIndex) {
        this._activeItemIndex = newIndex;
      }
    }
  }

  private _setTypeAhead(debounceInterval: number) {
    this._typeaheadSubscription.unsubscribe();

    if (
      (typeof ngDevMode === 'undefined' || ngDevMode) &&
      this._items.length &&
      this._items.some(item => typeof item.getLabel !== 'function')
    ) {
      throw new Error(
        'TreeKeyManager items in typeahead mode must implement the `getLabel` method.',
      );
    }

    // Debounce the presses of non-navigational keys, collect the ones that correspond to letters
    // and convert those letters back into a string. Afterwards find the first item that starts
    // with that string and select it.
    this._typeaheadSubscription = this._letterKeyStream
      .pipe(
        tap(letter => this._pressedLetters.push(letter)),
        debounceTime(debounceInterval),
        filter(() => this._pressedLetters.length > 0),
        map(() => this._pressedLetters.join('').toLocaleUpperCase()),
      )
      .subscribe(inputString => {
        // Start at 1 because we want to start searching at the item immediately
        // following the current active item.
        for (let i = 1; i < this._items.length + 1; i++) {
          const index = (this._activeItemIndex + i) % this._items.length;
          const item = this._items[index];

          if (
            !this._skipPredicateFn(item) &&
            item.getLabel?.().toLocaleUpperCase().trim().indexOf(inputString) === 0
          ) {
            this.setActiveItem(index);
            break;
          }
        }

        this._pressedLetters = [];
      });
  }

  //// Navigational methods

  private _focusFirstItem() {
    this.setActiveItem(this._findNextAvailableItemIndex(-1));
  }

  private _focusLastItem() {
    this.setActiveItem(this._findPreviousAvailableItemIndex(this._items.length));
  }

  private _focusPreviousItem() {
    this.setActiveItem(this._findPreviousAvailableItemIndex(this._activeItemIndex));
  }

  private _focusNextItem() {
    this.setActiveItem(this._findNextAvailableItemIndex(this._activeItemIndex));
  }

  private _findNextAvailableItemIndex(startingIndex: number) {
    for (let i = startingIndex + 1; i < this._items.length; i++) {
      if (!this._skipPredicateFn(this._items[i])) {
        return i;
      }
    }
    return startingIndex;
  }

  private _findPreviousAvailableItemIndex(startingIndex: number) {
    for (let i = startingIndex - 1; i >= 0; i--) {
      if (!this._skipPredicateFn(this._items[i])) {
        return i;
      }
    }
    return startingIndex;
  }

  /**
   * If the item is already expanded, we collapse the item. Otherwise, we will focus the parent.
   */
  private _collapseCurrentItem() {
    if (!this._activeItem) {
      return;
    }

    if (this._isCurrentItemExpanded()) {
      this._activeItem.collapse();
    } else {
      const parent = this._activeItem.getParent();
      if (!parent || this._skipPredicateFn(parent as T)) {
        return;
      }
      this.setActiveItem(parent as T);
    }
  }

  /**
   * If the item is already collapsed, we expand the item. Otherwise, we will focus the first child.
   */
  private _expandCurrentItem() {
    if (!this._activeItem) {
      return;
    }

    if (!this._isCurrentItemExpanded()) {
      this._activeItem.expand();
    } else {
      coerceObservable(this._activeItem.getChildren())
        .pipe(take(1))
        .subscribe(children => {
          const firstChild = children.find(child => !this._skipPredicateFn(child as T));
          if (!firstChild) {
            return;
          }
          this.setActiveItem(firstChild as T);
        });
    }
  }

  private _isCurrentItemExpanded() {
    if (!this._activeItem) {
      return false;
    }
    return typeof this._activeItem.isExpanded === 'boolean'
      ? this._activeItem.isExpanded
      : this._activeItem.isExpanded();
  }

  private _isItemDisabled(item: TreeKeyManagerItem) {
    return typeof item.isDisabled === 'boolean' ? item.isDisabled : item.isDisabled?.();
  }

  /** For all items that are the same level as the current item, we expand those items. */
  private _expandAllItemsAtCurrentItemLevel() {
    if (!this._activeItem) {
      return;
    }

    const parent = this._activeItem.getParent();
    let itemsToExpand;
    if (!parent) {
      itemsToExpand = observableOf(this._items.filter(item => item.getParent() === null));
    } else {
      itemsToExpand = coerceObservable(parent.getChildren());
    }

    itemsToExpand.pipe(take(1)).subscribe(items => {
      for (const item of items) {
        item.expand();
      }
    });
  }

  private _activateCurrentItem() {
    this._activeItem?.activate();
  }
}
