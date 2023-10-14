import styled, { css } from 'styled-components';

import { INTERFACE_DESKTOP_BREAKPOINT, INTERFACE_MOBILE_BREAKPOINT } from '~const/interface';
import { InterfaceBackgroundColor, InterfaceFont } from '~type/interface';

export const Label = styled.div`
  color: #fff;
  font-family: ${InterfaceFont.PIXEL_TEXT};
  font-size: 11px;
  line-height: 11px;
  text-transform: uppercase;
  letter-spacing: 1px;
  white-space: nowrap;
`;

export const Addon = styled.div`
  margin: 0 0 -1px 6px;
`;

export const Main = styled.div`
  display: flex;
  align-items: center;
`;

export const Key = styled.div`
  padding: 1px 2px 1px 3px;
  margin: 0 8px 0 -3px;
  font-family: ${InterfaceFont.PIXEL_TEXT};
  font-size: 9px;
  line-height: 9px;
  color: #fff;
  border: 1px solid #ffffffaa;
  background: ${InterfaceBackgroundColor.BLACK};
  border-radius: 2px;
`;

export const Container = styled.div<{
  $disabled?: boolean
}>`
  background: ${InterfaceBackgroundColor.BLACK_TRANSPARENT_75};
  pointer-events: all;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-radius: 5px;
  ${(props) => !props.$disabled && css`
    &:hover {
      cursor: pointer;
      background: ${InterfaceBackgroundColor.BLACK};
    }
  `}
  @media ${INTERFACE_DESKTOP_BREAKPOINT} {
    transform: translateX(-50%);
    padding: 6px 9px;
    ${(props) => props.$disabled && css`
      opacity: 0.75;
      ${Label}, ${Addon} {
        opacity: 0.7;
      }
    `}
  }
  @media ${INTERFACE_MOBILE_BREAKPOINT} {
    padding: 14px 15px;
    ${(props) => props.$disabled && css`
      opacity: 0.5;
    `}
  }
`;