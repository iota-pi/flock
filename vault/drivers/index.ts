import BaseDriver from './base';
import DynamoDriver from './dynamo';


const BACKENDS = {
  dynamo: new DynamoDriver(),
};

export default function getDriver(backend: keyof typeof BACKENDS) {
  return BACKENDS[backend].connect();
}
