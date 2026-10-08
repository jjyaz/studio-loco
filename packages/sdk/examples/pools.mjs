import { LocoClient, planRange } from '@studio-loco/sdk';
const loco = new LocoClient();
const snapshot = await loco.listPools({ perPage: 3 });
console.log(JSON.stringify(snapshot, null, 2));
console.log(planRange({ lower: -10, upper: 9, active: 12 }));
