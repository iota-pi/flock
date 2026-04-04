import { CSSProperties, HTMLAttributes } from 'react'
import { styled } from '@mui/material'
import OptionComponent from './Option'
import { AnySearchable } from './types'

export const OptionHolder = styled('li')({
  // Force border-box sizing so MUI's padding does not exceed virtual row height calculations
  boxSizing: 'border-box',
  padding: 0,
})

export interface SearchableRowSettings {
  showDescriptions: boolean,
  showGroupMemberCounts: boolean,
  showIcons: boolean,
  showCheckboxes: boolean,
  selected: boolean,
}

export type PropsAndOption = [HTMLAttributes<HTMLLIElement>, AnySearchable, SearchableRowSettings]

export interface SearchableRowProps {
  itemData: PropsAndOption[],
  index: number,
  style: CSSProperties,
}

export default function SearchableRow(
  props: SearchableRowProps,
) {
  const { itemData, index, style } = props
  const [optionProps, option, settings] = itemData[index]

  return (
    <OptionHolder
      {...optionProps}
      key={option.id}
      style={style}
    >
      <OptionComponent
        option={option}
        showDescription={settings.showDescriptions}
        showGroupMemberCount={settings.showGroupMemberCounts}
        showIcon={settings.showIcons}
        showCheckbox={settings.showCheckboxes}
        selected={settings.selected}
      />
    </OptionHolder>
  )
}
