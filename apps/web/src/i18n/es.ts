/** All UI strings (Spanish). Keys are English; keep this the only place with UI text. */
export const es = {
  appName: 'PdfClaudeAssistant',
  common: {
    loading: 'Cargando…',
    retry: 'Reintentar',
    error: 'Algo ha fallado.',
  },
  nav: {
    home: 'Inicio',
    library: 'Biblioteca',
    read: 'Leer',
    chat: 'Chat',
    review: 'Repaso',
    settings: 'Ajustes',
    logout: 'Cerrar sesión',
    mainNavigation: 'Navegación principal',
  },
  auth: {
    title: 'Entrar',
    subtitle: 'Tu asistente de estudio personal.',
    password: 'Contraseña',
    submit: 'Entrar',
    submitting: 'Entrando…',
    invalidPassword: 'Contraseña incorrecta.',
    tooManyAttempts: 'Demasiados intentos. Espera un minuto.',
  },
  home: {
    title: 'Inicio',
    welcome: 'Bienvenido. Aquí verás tu repaso de hoy y lo que estabas leyendo.',
  },
  settings: {
    title: 'Ajustes',
    theme: {
      title: 'Tema',
      system: 'Sistema',
      light: 'Claro',
      dark: 'Oscuro',
    },
    claude: {
      title: 'Conexión con Claude',
      description:
        'PdfClaudeAssistant usa tu suscripción de Claude a través de Claude Code. Nunca una API key.',
      check: 'Comprobar ahora',
      checking: 'Comprobando…',
      lastChecked: 'Última comprobación',
      model: 'Modelo',
      method: 'Método',
      states: {
        connected: 'Conectado con tu suscripción',
        auth_expired: 'Sesión caducada o sin iniciar',
        rate_limited: 'Límite de uso alcanzado',
        error: 'Error de conexión',
      },
      methods: {
        oauth_token: 'Token OAuth (CLAUDE_CODE_OAUTH_TOKEN)',
        interactive_login: 'Login interactivo en el servidor',
        other: 'Credenciales del entorno',
        none: 'Ninguno',
      },
      renewTitle: 'Cómo renovar la sesión',
      renewToken:
        'Opción recomendada: en cualquier equipo con Claude Code ejecuta «claude setup-token», copia el token en CLAUDE_CODE_OAUTH_TOKEN del .env del servidor y reinicia con «docker compose up -d».',
      renewLogin:
        'Alternativa: ejecuta «docker compose exec server claude», escribe /login e inicia sesión con tu cuenta.',
      rateLimitedHelp:
        'La app consume de los mismos límites que Claude Code y claude.ai. Vuelve a intentarlo cuando se renueve tu cuota.',
    },
  },
} as const;
