import { configure } from 'react-hotkeys'

const ignoreTags = new Set(['input', 'select', 'textarea'])

const configureHokeys = () => {
  configure({
    ignoreKeymapAndHandlerChangesByDefault: false,
    ignoreEventsCondition: (event: KeyboardEvent) => {
      if (event.ctrlKey || event.altKey || event.metaKey) {
        return false
      }

      if (event.target) {
        const target = event.target as HTMLElement
        return (
          target.isContentEditable
          || ignoreTags.has(target.tagName.toLowerCase())
        )
      }

      return false
    },
  })
}

export default configureHokeys
