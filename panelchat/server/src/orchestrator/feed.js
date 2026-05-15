// In-process pub/sub for SSE subscribers. Emits 'event' with a JSON-safe
// envelope per push.

import { EventEmitter } from 'node:events';

export class Feed extends EventEmitter {
    constructor() {
        super();
        this.setMaxListeners(0);
    }

    publish(envelope) {
        this.emit('event', envelope);
    }

    publishPost(post) {
        this.publish({ type: 'post', post });
    }

    publishState(state) {
        this.publish({ type: 'state', state });
    }

    publishProfiles(profiles) {
        this.publish({ type: 'profiles', profiles });
    }
}

export const feed = new Feed();
