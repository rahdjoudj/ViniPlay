import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

export function applySecurityMiddleware(app) {
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://cdn.jsdelivr.net",
          "https://cdn.tailwindcss.com",
          "https://www.gstatic.com",
        ],
        scriptSrcAttr: ["'unsafe-inline'"],
        workerSrc: ["'self'", "blob:"],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://cdn.jsdelivr.net",
          "https://fonts.googleapis.com",
        ],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", "https:", "wss:"],
        mediaSrc: ["'self'", "blob:", "https:"],
        frameSrc: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
  }));

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { error: 'Too many login attempts. Please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    validate: { trustProxy: false },
  });

  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth/setup-admin', authLimiter);

  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    skip: (req) => req.path === '/image-proxy',
    message: { error: 'Too many requests. Please slow down.' },
    standardHeaders: true,
    legacyHeaders: false,
    validate: { trustProxy: false },
  });

  app.use('/api', apiLimiter);

  const imageProxyLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 600,
    message: { error: 'Too many image requests. Please slow down.' },
    standardHeaders: true,
    legacyHeaders: false,
    validate: { trustProxy: false },
  });

  app.use('/api/image-proxy', imageProxyLimiter);
}
