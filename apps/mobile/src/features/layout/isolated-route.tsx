import {
  createNavigatorFactory,
  NavigationContainer,
  NavigationIndependentTree,
  StackRouter,
  useNavigation,
  useNavigationBuilder,
  type NavigatorTypeBagBase,
  type ParamListBase,
  type RouteProp,
  type StackActionHelpers,
  type StackNavigationState,
  type StackRouterOptions,
  type StaticConfig,
  type TypedNavigator,
} from "@react-navigation/native";
import type {
  NativeStackNavigationEventMap,
  NativeStackNavigationOptions,
  NativeStackNavigatorProps,
  NativeStackTypeBag,
} from "@react-navigation/native-stack";
import type { ReactNode } from "react";

import { useMobileNavigationTheme } from "../../lib/useMobileNavigationTheme";

function IsolatedRouteNavigator({
  id,
  initialRouteName,
  UNSTABLE_routeNamesChangeBehavior,
  children,
  layout,
  screenListeners,
  screenOptions,
  screenLayout,
  UNSTABLE_router,
}: NativeStackNavigatorProps) {
  const { state, descriptors, NavigationContent } = useNavigationBuilder<
    StackNavigationState<ParamListBase>,
    StackRouterOptions,
    StackActionHelpers<ParamListBase>,
    NativeStackNavigationOptions,
    NativeStackNavigationEventMap
  >(StackRouter, {
    id,
    initialRouteName,
    UNSTABLE_routeNamesChangeBehavior,
    children,
    layout,
    screenListeners,
    screenOptions,
    screenLayout,
    UNSTABLE_router,
  });
  const route = state.routes[state.index];
  return <NavigationContent>{route ? descriptors[route.key]?.render() : null}</NavigationContent>;
}

type IsolatedTypeBag<ParamList extends ParamListBase> = Omit<
  NativeStackTypeBag<ParamList, undefined>,
  "Navigator"
> & { Navigator: typeof IsolatedRouteNavigator };

function createIsolatedRouteNavigator<
  const ParamList extends ParamListBase,
  const TypeBag extends NavigatorTypeBagBase = IsolatedTypeBag<ParamList>,
  const Config extends StaticConfig<TypeBag> = StaticConfig<TypeBag>,
>(config?: Config): TypedNavigator<TypeBag, Config> {
  return createNavigatorFactory(IsolatedRouteNavigator)(config);
}

const Isolated = createIsolatedRouteNavigator<ParamListBase>();

/**
 * Renders a screen under a route of its own, so its route hooks, `setParams` and `replace` never
 * reach the host screen; actions it can't handle go to the host. It draws no native UI: the
 * screen's AppBar writes into whatever bar hosts it.
 */
export function IsolatedRoute<const Name extends string, Params extends object>(props: {
  readonly name: Name;
  readonly params: Params;
  /** A new key starts a new route, dropping the old one's state. */
  readonly routeKey: string;
  readonly children: (route: RouteProp<Record<Name, Params>, Name>) => ReactNode;
}) {
  const host = useNavigation();
  const theme = useMobileNavigationTheme();
  return (
    <NavigationIndependentTree>
      <NavigationContainer theme={theme} onUnhandledAction={host.dispatch}>
        <Isolated.Navigator key={props.routeKey}>
          <Isolated.Screen name={props.name} initialParams={props.params}>
            {(screen) => props.children(screen.route as RouteProp<Record<Name, Params>, Name>)}
          </Isolated.Screen>
        </Isolated.Navigator>
      </NavigationContainer>
    </NavigationIndependentTree>
  );
}
