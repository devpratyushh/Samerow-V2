import test from 'node:test';
import assert from 'node:assert/strict';
import { availabilityFor, lastSeenLabel } from '../src/jellyfinAvailability.js';
test('device offline and unavailable gateway never mislabel the bound server as offline', () => {
 const server={status:'ready',message:'Ready'};
 assert.equal(availabilityFor(server,{online:false}).status,'client_offline');
 assert.equal(availabilityFor(server,{unavailable:true}).status,'unknown');
 assert.equal(availabilityFor({status:'offline'}).status,'offline');
 assert.equal(server.status,'ready');
 assert.equal(lastSeenLabel(100000,220000),'Last reached 2 minutes ago');
});
