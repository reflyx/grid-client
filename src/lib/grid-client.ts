import { filter, firstValueFrom, map, Observable, Subject } from 'rxjs';

export interface GridClientApi {
  signal<T>(target: string | string[], type: string, data: T): void;
  request<T>(target: string | string[], request: string | RequestSpec, data: any, replyTo?: string): Promise<T>;
  requestStream<T>(target: string | string[], request: string | RequestSpec, data: any, replyTo?: string): Observable<T>;
  broadcast<T>(topic: string | string[], message: T): void;
  close(): Promise<void>;
  messages: Observable<Message<any>>;
  lifecycle: Observable<{ id: string; status: string }>;
  status: string;
}

export type Message<T> = { topic: string; message?: T; error?: Error };
export type LifecycleEvent = { id: string; status: string };
export type RequestSpec = { type: string; id: string };

export function gridClientApi({ nodeId, gridClient }: { nodeId: string; gridClient: any }): GridClientApi {
  const lifecycle = new Subject<LifecycleEvent>();
  const messages = new Subject<Message<any>>();

  gridClient.subscribe(['rfx01', 'node', nodeId, 'inbox'].join('/'), {
    qos: 1,
  });

  gridClient.on('message', (topic: string, message: any) => {
    messages.next({ topic, message: JSON.parse(message) });
  });

  gridClient.on('connect', () => {
    lifecycle.next({ id: nodeId, status: 'connected' });
  });

  gridClient.on('error', (err: Error) => {
    messages.next({ topic: 'error', error: err });
  });
  gridClient.on('reconnect', () => {
    lifecycle.next({ id: nodeId, status: 'reconnected' });
  });
  gridClient.on('disconnect', () => {
    lifecycle.next({ id: nodeId, status: 'disconnected' });
  });
  gridClient.on('close', () => {
    lifecycle.next({ id: nodeId, status: 'closed' });
  });

  return {
    signal(target, type, data) {
      if (Array.isArray(target)) {
        target = target.join('/');
      }
      gridClient.publish(target, JSON.stringify({ from: nodeId, signal: type || 'signal', data }), { qos: 1 });
    },
    request(target, request, data, replyTo) {
      if (Array.isArray(target)) {
        target = target.join('/');
      }
      let req: RequestSpec;
      if (typeof request === 'string') {
        req = {
          type: request,
          id: request + '-' + Math.random().toString(36).substring(2, 15),
        };
      } else {
        req = request;
      }

      if (!replyTo) {
        replyTo = `${nodeId}/${req.type}/${req.id}`;
        gridClient.subscribe(replyTo, { qos: 1 });
      }

      return firstValueFrom(
        new Observable<any>((subscriber) => {
          gridClient.publish(target, JSON.stringify({ from: nodeId, request: req, data, replyTo }), { qos: 1 });
          const sub$ = messages
            .pipe(
              filter((m) => m.message?.forRequest === req.id),
              map((m) => m.message)
            )
            .subscribe(subscriber);
          return () => {
            sub$.unsubscribe();
            gridClient.unsubscribe(replyTo);
          };
        })
      );
    },
    requestStream<T>(target: string | string[], request: string | RequestSpec, data: any, replyTo?: string): Observable<T> {
      if (Array.isArray(target)) {
        target = target.join('/');
      }
      let req: RequestSpec;
      if (typeof request === 'string') {
        req = {
          type: request,
          id: request + '-' + Math.random().toString(36).substring(2, 15),
        };
      } else {
        req = request;
      }

      if (!replyTo) {
        replyTo = `${nodeId}/${req.type}/${req.id}`;
        gridClient.subscribe(replyTo, { qos: 1 });
      }
      gridClient.publish(target, JSON.stringify({ request: req, data, replyTo }));
      return new Observable<T>((subscriber) => {
        const sub$ = messages
          .pipe(
            filter((m) => m.message?.forRequest === req.id),
            map((m) => m.message)
          )
          .subscribe(subscriber);
        return () => {
          sub$.unsubscribe();
          gridClient.unsubscribe(replyTo);
        };
      });
    },
    broadcast(topic, message) {
      if (Array.isArray(topic)) {
        topic = topic.join('/');
      }
      gridClient.publish(topic, JSON.stringify({ ...message, from: nodeId }));
    },
    async close() {
      console.log('closing mqtt client');
      return await gridClient.endAsync();
    },
    get messages() {
      return messages.asObservable();
    },
    get lifecycle() {
      return lifecycle.asObservable();
    },
    get status() {
      return gridClient.status;
    },
  };
}
