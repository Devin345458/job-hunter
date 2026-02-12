interface SnackbarAction {
  text: string
  handler: () => void
}

interface SnackbarState {
  show: boolean
  message: string
  color: string
  icon: string
  timeout: number
  action: SnackbarAction | null
}

const state = reactive<SnackbarState>({
  show: false,
  message: '',
  color: 'info',
  icon: 'mdi-information',
  timeout: 4000,
  action: null,
})

const iconMap: Record<string, string> = {
  success: 'mdi-check-circle',
  error: 'mdi-alert-circle',
  warning: 'mdi-alert',
  info: 'mdi-information',
  primary: 'mdi-information',
}

export function useSnackbar() {
  function notify(
    message: string,
    color = 'info',
    options?: { timeout?: number; action?: SnackbarAction },
  ) {
    state.message = message
    state.color = color
    state.icon = iconMap[color] || 'mdi-information'
    state.timeout = options?.timeout ?? (color === 'error' ? 6000 : 4000)
    state.action = options?.action ?? null
    state.show = true
  }

  function success(message: string, action?: SnackbarAction) {
    notify(message, 'success', { action })
  }

  function error(message: string, action?: SnackbarAction) {
    notify(message, 'error', { timeout: 6000, action })
  }

  function warning(message: string, action?: SnackbarAction) {
    notify(message, 'warning', { action })
  }

  function info(message: string, action?: SnackbarAction) {
    notify(message, 'info', { action })
  }

  return {
    state,
    notify,
    success,
    error,
    warning,
    info,
  }
}
