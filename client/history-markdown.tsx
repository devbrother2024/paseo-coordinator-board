import { createContext, useContext, useMemo, type ReactNode } from "react";
import { Platform, Text, View, type TextStyle } from "react-native";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { lexBoardMarkdown } from "./board-markdown";
import { GitHubPullLink } from "./github-pull-link";
import { fallbackRepository, pullReferenceTokens, tableRowClues, type PullLinkContext } from "./pull-reference-markdown";
import type { RepositoryIndex } from "./pull-repositories";
import type { Token, Tokens } from "./vendor/marked/marked";
import type { Theme } from "./controls";

const codeFont = Platform.OS === "ios" ? "Menlo" : "monospace";

/** Repositories the board knows, so a `#N` can link to the repository its own line names. */
export const KnownPullRepositories = createContext<RepositoryIndex | undefined>(undefined);

function inline(tokens:Token[], theme:Theme):ReactNode[] {
  return tokens.map((token,i) => {
    const children = () => "tokens" in token && token.tokens ? inline(token.tokens,theme) : "text" in token ? token.text : token.raw;
    switch (token.type) {
      case "strong": return <Text key={i} style={{fontWeight:"700"}}>{children()}</Text>;
      case "em": return <Text key={i} style={{fontStyle:"italic"}}>{children()}</Text>;
      case "del": return <Text key={i} style={{textDecorationLine:"line-through"}}>{children()}</Text>;
      case "codespan": return <Text key={i} style={{fontFamily:codeFont,backgroundColor:theme.colors.surface2}}>{token.text}</Text>;
      case "pullReference": return <GitHubPullLink key={i} repo={token.repo} number={token.number} theme={theme} inline />;
      case "link": {
        const href=String(token.href);
        return /^https?:\/\//i.test(href)
          ? <Text key={i} accessibilityRole="link" style={{textDecorationLine:"underline"}} onPress={()=>void openExternalUrl(href).catch(()=>{})}>{children()}</Text>
          : children();
      }
      case "br": return "\n";
      case "html": return /^<br\s*\/?\s*>$/i.test(token.raw) ? "\n" : token.raw;
      case "image": return token.text;
      case "checkbox": return token.checked ? "☑ " : "☐ ";
      default: return children() ?? token.raw;
    }
  });
}

// `preview` shows the first block in `lines` lines (two by default).
export function HistoryMarkdown({source,fallbackSource,theme,pullRepository,preview=false,lines=2,heading=false,muted=false}:{
  /** `fallbackSource`: the whole text when `source` is only a collapsed part of it; the card repository is judged on all of it. */
  source:string;fallbackSource?:string;theme:Theme;pullRepository?:string;preview?:boolean;lines?:number;heading?:boolean;muted?:boolean;
}) {
  const tokens=useMemo(()=>lexBoardMarkdown(source),[source]);
  const known=useContext(KnownPullRepositories);
  // The card's repository applies only when the whole text names no other repository.
  const repository=useMemo(()=>fallbackRepository(fallbackSource === undefined ? tokens : lexBoardMarkdown(fallbackSource),pullRepository,known),
    [tokens,fallbackSource,pullRepository,known]);
  const colors=theme.colors;
  const base:TextStyle={color:muted ? colors.foregroundMuted : colors.foreground,fontSize:muted ? 13 : 14,lineHeight:21};
  function paragraph(token:Token,i:number,style?:TextStyle,title=false) {
    return <Text key={i} accessibilityRole={title || token.type === "heading" ? "header" : undefined} selectable numberOfLines={preview ? lines : undefined} style={[base,title && {fontSize:15,fontWeight:"600"},style]}>
      {"tokens" in token && token.tokens ? renderInline(token.tokens) : "text" in token ? token.text : token.raw}
    </Text>;
  }
  const renderInline = (tokens: Token[], row?: PullLinkContext["row"]) => inline(pullReferenceTokens(tokens, { repository, known, row }), theme);
  function blocks(all:Token[],topLevel=false):ReactNode[] {
    const visible=all.filter(token=>!["space","def"].includes(token.type));
    return (preview ? visible.slice(0,1) : visible).map((token,i)=>{
      switch (token.type) {
        case "heading": return paragraph(token,i,{fontSize:token.depth<=2 ? 16 : 14,fontWeight:"700"});
        case "hr": return <View key={i} style={{height:1,backgroundColor:colors.border}}/>;
        case "code": return paragraph(token,i,{fontFamily:codeFont,backgroundColor:colors.surface2,padding:6});
        case "blockquote": return <View key={i} style={{borderLeftWidth:2,borderColor:colors.border,paddingLeft:8,gap:4}}>{blocks(token.tokens ?? [])}</View>;
        case "list": {
          const list=token as Tokens.List;
          return <View key={i} style={{gap:4}}>{(preview ? list.items.slice(0,1) : list.items).map((item,n)=>
            <View key={n} style={{flexDirection:"row",gap:6}}>
              <Text style={base}>{list.ordered ? String(Number(list.start)+n)+"." : "•"}</Text>
              <View style={{flex:1,minWidth:0,gap:4}}>{blocks(item.tokens)}</View>
            </View>)}</View>;
        }
        case "table": {
          const table=token as Tokens.Table;
          const rows=[table.header,...(preview ? table.rows.slice(0,1) : table.rows)];
          const clues=[null,...tableRowClues(table,known)];
          return <View key={i}>{rows.map((row,r)=><View key={r} style={{flexDirection:"row",borderBottomWidth:1,borderColor:colors.border}}>
            {row.map((cell,c)=><Text key={c} selectable style={[base,{flex:1,minWidth:0,padding:4,textAlign:cell.align ?? "left",fontWeight:cell.header ? "700" : "400"}]}>{renderInline(cell.tokens,clues[r])}</Text>)}
          </View>)}</View>;
        }
        default:return paragraph(token,i,undefined,topLevel && heading && i === 0);
      }
    });
  }
  // Fills the width its parent gives. Under a parent with `alignItems: "flex-start"` the root would shrink to its content, and a list item's `flex:1` text column then gets almost no width on iOS: the text wraps a character or two at a time and overlaps what follows.
  return <View style={{gap:6,alignSelf:"stretch"}}>{blocks(tokens,true)}</View>;
}
