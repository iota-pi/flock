import ReactMarkdown, { MarkdownToJSX } from 'markdown-to-jsx'
import {
  Box,
  Link,
  Typography,
} from '@mui/material'

function MarkdownListItem(props: object) {
  return <Box component="li" sx={{ typography: 'body1' }} {...props} />
}

const options: MarkdownToJSX.Options = {
  overrides: {
    h1: {
      component: Typography,
      props: {
        gutterBottom: true,
        variant: 'h4',
        component: 'h1',
      },
    },
    h2: {
      component: Typography,
      props: { gutterBottom: true, variant: 'h6', component: 'h2' },
    },
    h3: {
      component: Typography,
      props: { gutterBottom: true, variant: 'subtitle1' },
    },
    h4: {
      component: Typography,
      props: {
        gutterBottom: true,
        variant: 'caption',
        paragraph: true,
      },
    },
    p: {
      component: Typography,
      props: { paragraph: true },
    },
    a: { component: Link },
    li: {
      component: MarkdownListItem,
    },
  },
}

export default function Markdown(props: { children: string } & object) {
  return <ReactMarkdown options={options} {...props} />
}
