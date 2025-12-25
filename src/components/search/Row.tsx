import { HTMLAttributes } from 'react'
import { RowComponentProps } from 'react-window'
import { styled } from '@mui/material'
import OptionComponent from './Option'
import { AnySearchable } from './types'

export const OptionHolder = styled('li')({
  display: 'block',
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
}

export default function SearchableRow(
  props: RowComponentProps<SearchableRowProps>,
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
