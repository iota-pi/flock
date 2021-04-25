import getDriver from '.';
import { getConnectionParams } from './dynamo';

getDriver('dynamo').init(getConnectionParams());
