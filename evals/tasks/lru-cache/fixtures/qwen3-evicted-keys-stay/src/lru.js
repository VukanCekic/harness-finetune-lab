export default class LRUCache {
  constructor(capacity) {
    if (typeof capacity !== 'number' || !Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError('Capacity must be a positive integer');
    }
    this.capacity = capacity;
    this.cache = new Map();
    this.head = null;
    this.tail = null;
    this._size = 0;
  }

  get(key) {
    if (!this.cache.has(key)) {
      return undefined;
    }
    const node = this.cache.get(key);
    this.moveToFront(node);
    return node.value;
  }

  set(key, value) {
    if (this.cache.has(key)) {
      const node = this.cache.get(key);
      node.value = value;
      this.moveToFront(node);
    } else {
      const node = { key, value, next: null, prev: null };
      this.cache.set(key, node);
      this.addToFront(node);
      if (this._size > this.capacity) {
        this.removeTail();
      }
    }
  }

  has(key) {
    return this.cache.has(key);
  }

  delete(key) {
    if (!this.cache.has(key)) {
      return;
    }
    const node = this.cache.get(key);
    this.removeNode(node);
    this.cache.delete(key);
  }

  get size() {
    return this._size;
  }

  moveToFront(node) {
    this.removeNode(node);
    this.addToFront(node);
  }

  addToFront(node) {
    if (this.head === null) {
      this.head = node;
      this.tail = node;
    } else {
      node.next = this.head;
      this.head.prev = node;
      this.head = node;
    }
    this._size++;
  }

  removeNode(node) {
    if (node.prev) {
      node.prev.next = node.next;
    } else {
      // Node is head
      this.head = node.next;
    }
    if (node.next) {
      node.next.prev = node.prev;
    } else {
      // Node is tail
      this.tail = node.prev;
    }
    this._size--;
  }

  removeTail() {
    const node = this.tail;
    this.removeNode(node);
  }
}