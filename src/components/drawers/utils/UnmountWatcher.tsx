import { Component } from 'react'

export interface Props {
  onUnmount?: () => void,
}

class UnmountWatcher extends Component<Props> {
  shouldComponentUpdate() {
    return false
  }

  componentWillUnmount() {
    if (this.props.onUnmount) {
      this.props.onUnmount()
    }
  }

  render() {
    return null
  }
}

export default UnmountWatcher
