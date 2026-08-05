import { CSSProperties, HTMLAttributes } from 'react'
import OptionComponent from './Option'
import { AnySearchable } from './types'


interface SearchableRowSettings {
  showDescriptions: boolean,
  showGroupMemberCounts: boolean,
  showIcons: boolean,
  showCheckboxes: boolean,
  selected: boolean,
}

export type PropsAndOption = [HTMLAttributes<HTMLLIElement>, AnySearchable, SearchableRowSettings]

interface SearchableRowProps {
  itemData: PropsAndOption[],
  index: number,
  measureRef?: (node: HTMLElement | null) => void,
  style?: CSSProperties,
}

export default function SearchableRow(
  props: SearchableRowProps,
) {
  const { itemData, index, measureRef, style } = props
  const [optionProps, option, settings] = itemData[index]

  return (
    <li
      {...optionProps}
      key={option.id}
      style={style}
      ref={measureRef}
      data-index={index}
    >
      <OptionComponent
        option={option}
        showDescription={settings.showDescriptions}
        showGroupMemberCount={settings.showGroupMemberCounts}
        showIcon={settings.showIcons}
        showCheckbox={settings.showCheckboxes}
        selected={settings.selected}
      />
    </li>
  )
}
