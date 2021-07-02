import winston from 'winston';


export const defaultTransports = [
  new winston.transports.Console({
    silent: process.env.NODE_ENV === 'test',
  }),
];

export const defaultConfig: winston.LoggerOptions = {
  level: 'info',
  format: winston.format.json(),
  defaultMeta: { component: 'vault' },
  transports: defaultTransports,
};

export function getLogger(extra?: Record<string, any>) {
  return winston.createLogger({
    ...defaultConfig,
    defaultMeta: { ...defaultConfig.defaultMeta, ...extra },
  });
}

export default getLogger();
